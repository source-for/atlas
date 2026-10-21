#[cfg(target_arch = "wasm32")]
use std::borrow::Cow;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use atlas_engine::{Camera, ProtocolFrame, RendererBackend};
use atlas_protocol::SceneSnapshot;
use bytemuck::{Pod, Zeroable};
use thiserror::Error;
use wgpu::util::DeviceExt;

use crate::{
    GlyphAtlas, GpuMesh, MeshStats, Vertex, VertexStyle, build_active_mesh_stream,
    build_flow_vertices, build_mesh,
};

#[cfg(target_arch = "wasm32")]
const SHADER: &str = include_str!("shaders/primitives.wgsl");
const CLEAR_COLOR: wgpu::Color = wgpu::Color {
    r: 0.027,
    g: 0.039,
    b: 0.071,
    a: 1.0,
};

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
struct CameraUniform {
    center_viewport: [f32; 4],
    zoom_padding: [f32; 4],
}

impl CameraUniform {
    fn from_camera(camera: &Camera) -> Self {
        let center = camera.center();
        let viewport = camera.viewport();
        Self {
            center_viewport: [
                center.x as f32,
                center.y as f32,
                viewport.css_width as f32,
                viewport.css_height as f32,
            ],
            zoom_padding: [camera.zoom() as f32, 0.0, 0.0, 0.0],
        }
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable, PartialEq)]
struct LodUniform {
    weights: [f32; 4],
}

impl LodUniform {
    fn from_frame(mesh: &GpuMesh, frame: &ProtocolFrame) -> Self {
        Self {
            weights: crate::mesh::lod_uniform_weights(mesh, frame),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MeshCacheKey {
    scene_id_hash: u64,
    scene_revision: u64,
    geometry_epoch: u64,
}

impl MeshCacheKey {
    fn new(snapshot: &SceneSnapshot, frame: &ProtocolFrame) -> Self {
        Self {
            scene_id_hash: hash_bytes(snapshot.scene_id.as_bytes()),
            scene_revision: snapshot.revision,
            geometry_epoch: frame.geometry_epoch,
        }
    }
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut state = FNV_OFFSET;
    for byte in bytes {
        state ^= u64::from(*byte);
        state = state.wrapping_mul(FNV_PRIME);
    }
    state
}

fn static_mesh_rebuild_required(cached: Option<&CachedMesh>, key: MeshCacheKey) -> bool {
    cached.is_none_or(|cached| cached.key != key)
}

const fn surface_size_changed(current: (u32, u32), next: (u32, u32)) -> bool {
    current.0 != next.0 || current.1 != next.1
}

#[derive(Debug, Clone)]
struct CachedMesh {
    key: MeshCacheKey,
    mesh: GpuMesh,
    span_styles: Vec<VertexStyle>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct GpuRenderReport {
    pub mesh_stats: MeshStats,
    pub mesh_rebuilt: bool,
    pub mesh_build_ms: f32,
    pub geometry_upload_bytes: u64,
    pub geometry_buffer_uploads: u32,
    pub static_mesh_revision: u64,
    pub cumulative_geometry_upload_bytes: u64,
    pub cumulative_geometry_buffer_uploads: u64,
    pub dynamic_index_upload_bytes: u64,
    pub dynamic_index_buffer_uploads: u32,
    pub cumulative_dynamic_index_upload_bytes: u64,
    pub cumulative_dynamic_index_buffer_uploads: u64,
    pub dynamic_style_upload_bytes: u64,
    pub dynamic_style_buffer_uploads: u32,
    pub cumulative_dynamic_style_upload_bytes: u64,
    pub cumulative_dynamic_style_buffer_uploads: u64,
    pub flow_upload_bytes: u64,
    pub cumulative_flow_upload_bytes: u64,
    pub uniform_upload_bytes: u64,
    pub cumulative_uniform_upload_bytes: u64,
    pub lod_uniform_upload_bytes: u64,
    pub cumulative_lod_uniform_upload_bytes: u64,
    pub partition_total: u32,
    pub partition_active: u32,
    pub partition_drawn: u32,
    pub resident_object_count: u32,
    pub resident_path_count: u32,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub cache_evictions: u64,
    pub draw_range_count: u32,
    pub draw_calls: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum BackendPreference {
    #[default]
    Auto,
    WebGpu,
    WebGl2,
}

impl BackendPreference {
    #[must_use]
    pub fn from_query(value: Option<&str>) -> Self {
        match value {
            Some("webgpu") => Self::WebGpu,
            Some("webgl2") => Self::WebGl2,
            _ => Self::Auto,
        }
    }

    #[cfg(target_arch = "wasm32")]
    fn backends(self) -> wgpu::Backends {
        match self {
            Self::Auto => wgpu::Backends::BROWSER_WEBGPU | wgpu::Backends::GL,
            Self::WebGpu => wgpu::Backends::BROWSER_WEBGPU,
            Self::WebGl2 => wgpu::Backends::GL,
        }
    }
}

#[derive(Debug, Error)]
pub enum GpuError {
    #[error("the requested GPU backend is unavailable")]
    AdapterUnavailable,
    #[error("failed to create canvas surface: {0}")]
    CreateSurface(#[from] wgpu::CreateSurfaceError),
    #[error("failed to create GPU device: {0}")]
    RequestDevice(#[from] wgpu::RequestDeviceError),
    #[error("canvas surface has no compatible format")]
    MissingSurfaceFormat,
    #[error("surface frame failed: {0}")]
    Surface(#[from] wgpu::SurfaceError),
    #[error("GPU surface was lost and requires a fresh canvas")]
    SurfaceLost,
    #[error("GPU device was lost: {0}")]
    DeviceLost(String),
    #[error("GPU pipeline validation failed: {0}")]
    PipelineValidation(String),
}

#[derive(Debug, Default)]
struct DeviceLossState {
    lost: AtomicBool,
    message: Mutex<Option<String>>,
}

impl DeviceLossState {
    #[cfg(any(target_arch = "wasm32", test))]
    fn mark(&self, reason: wgpu::DeviceLostReason, message: String) {
        let detail = if message.is_empty() {
            format!("{reason:?}")
        } else {
            format!("{reason:?}: {message}")
        };
        if let Ok(mut stored) = self.message.lock() {
            *stored = Some(detail);
        }
        self.lost.store(true, Ordering::Release);
    }

    fn error(&self) -> Option<GpuError> {
        if !self.lost.load(Ordering::Acquire) {
            return None;
        }
        let message = self
            .message
            .lock()
            .ok()
            .and_then(|stored| stored.clone())
            .unwrap_or_else(|| "unknown device loss".into());
        Some(GpuError::DeviceLost(message))
    }
}

/// Browser-oriented wgpu surface renderer. Its pipeline uses only a vertex
/// buffer and alpha blending so the same WGSL works on WebGPU and the WebGL2
/// downlevel backend.
pub struct GpuRenderer {
    _instance: wgpu::Instance,
    surface: wgpu::Surface<'static>,
    adapter_info: wgpu::AdapterInfo,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    resources_bind_group: wgpu::BindGroup,
    camera_buffer: wgpu::Buffer,
    lod_buffer: wgpu::Buffer,
    last_lod_uniform: Option<LodUniform>,
    vertex_buffer: wgpu::Buffer,
    style_buffer: wgpu::Buffer,
    vertex_capacity: usize,
    index_buffer: wgpu::Buffer,
    index_capacity: usize,
    active_indices: Vec<u32>,
    flow_vertex_buffer: wgpu::Buffer,
    flow_style_buffer: wgpu::Buffer,
    flow_vertex_capacity: usize,
    flow_vertices: Vec<Vertex>,
    glyph_atlas: GlyphAtlas,
    cached_mesh: Option<CachedMesh>,
    static_mesh_revision: u64,
    cumulative_geometry_upload_bytes: u64,
    cumulative_geometry_buffer_uploads: u64,
    cumulative_dynamic_index_upload_bytes: u64,
    cumulative_dynamic_index_buffer_uploads: u64,
    cumulative_dynamic_style_upload_bytes: u64,
    cumulative_dynamic_style_buffer_uploads: u64,
    cumulative_flow_upload_bytes: u64,
    cumulative_uniform_upload_bytes: u64,
    cumulative_lod_uniform_upload_bytes: u64,
    cache_hits: u64,
    cache_misses: u64,
    cache_evictions: u64,
    device_loss: Arc<DeviceLossState>,
}

impl std::fmt::Debug for GpuRenderer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GpuRenderer")
            .field("adapter_info", &self.adapter_info)
            .field("config", &self.config)
            .field("vertex_capacity", &self.vertex_capacity)
            .field("index_capacity", &self.index_capacity)
            .field("cached_mesh", &self.cached_mesh.is_some())
            .finish_non_exhaustive()
    }
}

impl GpuRenderer {
    #[cfg(target_arch = "wasm32")]
    pub async fn from_canvas(
        canvas: web_sys::HtmlCanvasElement,
        width: u32,
        height: u32,
        preference: BackendPreference,
    ) -> Result<Self, GpuError> {
        // A browser canvas may only safely bind one context family. `auto`
        // therefore performs the WebGPU attempt; the host must replace the
        // canvas before retrying this factory with explicit `webgl2`.
        let backend = if preference == BackendPreference::Auto {
            BackendPreference::WebGpu
        } else {
            preference
        };
        Self::from_canvas_backend(canvas, width, height, backend).await
    }

    #[cfg(target_arch = "wasm32")]
    async fn from_canvas_backend(
        canvas: web_sys::HtmlCanvasElement,
        width: u32,
        height: u32,
        preference: BackendPreference,
    ) -> Result<Self, GpuError> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: preference.backends(),
            ..Default::default()
        });
        let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas))?;
        Self::from_surface(instance, surface, width, height).await
    }

    #[cfg(target_arch = "wasm32")]
    async fn from_surface(
        instance: wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Self, GpuError> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
            })
            .await
            .map_err(|_| GpuError::AdapterUnavailable)?;
        let limits = wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits());
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("okie-atlas-device"),
                required_features: wgpu::Features::empty(),
                required_limits: limits,
                memory_hints: wgpu::MemoryHints::MemoryUsage,
                trace: wgpu::Trace::Off,
            })
            .await?;
        let device_loss = Arc::new(DeviceLossState::default());
        let callback_state = Arc::clone(&device_loss);
        device.set_device_lost_callback(move |reason, message| {
            callback_state.mark(reason, message);
        });
        let adapter_info = adapter.get_info();
        let capabilities = surface.get_capabilities(&adapter);
        let format =
            select_surface_format(&capabilities.formats).ok_or(GpuError::MissingSurfaceFormat)?;
        let present_mode = if capabilities
            .present_modes
            .contains(&wgpu::PresentMode::Fifo)
        {
            wgpu::PresentMode::Fifo
        } else {
            capabilities.present_modes[0]
        };
        let alpha_mode = capabilities
            .alpha_modes
            .first()
            .copied()
            .unwrap_or(wgpu::CompositeAlphaMode::Auto);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let glyph_atlas = GlyphAtlas::new();
        let camera_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("okie-atlas-camera"),
            contents: bytemuck::bytes_of(&CameraUniform::zeroed()),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let lod_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("okie-atlas-lod"),
            contents: bytemuck::bytes_of(&LodUniform { weights: [1.0; 4] }),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let glyph_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("okie-atlas-glyph-atlas"),
            size: wgpu::Extent3d {
                width: glyph_atlas.width(),
                height: glyph_atlas.height(),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &glyph_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            glyph_atlas.pixels(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(glyph_atlas.width()),
                rows_per_image: Some(glyph_atlas.height()),
            },
            wgpu::Extent3d {
                width: glyph_atlas.width(),
                height: glyph_atlas.height(),
                depth_or_array_layers: 1,
            },
        );
        let glyph_view = glyph_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let glyph_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("okie-atlas-glyph-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        let resources_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("okie-atlas-resources-layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let resources_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("okie-atlas-resources"),
            layout: &resources_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: camera_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&glyph_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&glyph_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: lod_buffer.as_entire_binding(),
                },
            ],
        });
        device.push_error_scope(wgpu::ErrorFilter::Validation);
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("okie-atlas-primitives"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(SHADER)),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("okie-atlas-pipeline-layout"),
            bind_group_layouts: &[&resources_layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("okie-atlas-pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[Vertex::layout(), VertexStyle::layout()],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        if let Some(error) = device.pop_error_scope().await {
            return Err(GpuError::PipelineValidation(error.to_string()));
        }
        let vertex_capacity = 6;
        let vertex_buffer = create_vertex_buffer(&device, vertex_capacity);
        let style_buffer = create_style_buffer(&device, vertex_capacity);
        let index_capacity = 6;
        let index_buffer = create_index_buffer(&device, index_capacity);
        let flow_vertex_capacity = 6;
        let flow_vertex_buffer = create_vertex_buffer(&device, flow_vertex_capacity);
        let flow_style_buffer = create_style_buffer(&device, flow_vertex_capacity);
        Ok(Self {
            _instance: instance,
            surface,
            adapter_info,
            device,
            queue,
            config,
            pipeline,
            resources_bind_group,
            camera_buffer,
            lod_buffer,
            last_lod_uniform: None,
            vertex_buffer,
            style_buffer,
            vertex_capacity,
            index_buffer,
            index_capacity,
            active_indices: Vec::new(),
            flow_vertex_buffer,
            flow_style_buffer,
            flow_vertex_capacity,
            flow_vertices: Vec::new(),
            glyph_atlas,
            cached_mesh: None,
            static_mesh_revision: 0,
            cumulative_geometry_upload_bytes: 0,
            cumulative_geometry_buffer_uploads: 0,
            cumulative_dynamic_index_upload_bytes: 0,
            cumulative_dynamic_index_buffer_uploads: 0,
            cumulative_dynamic_style_upload_bytes: 0,
            cumulative_dynamic_style_buffer_uploads: 0,
            cumulative_flow_upload_bytes: 0,
            cumulative_uniform_upload_bytes: 0,
            cumulative_lod_uniform_upload_bytes: 0,
            cache_hits: 0,
            cache_misses: 0,
            cache_evictions: 0,
            device_loss,
        })
    }

    #[must_use]
    pub fn backend(&self) -> RendererBackend {
        match self.adapter_info.backend {
            wgpu::Backend::BrowserWebGpu => RendererBackend::WebGpu,
            wgpu::Backend::Gl if cfg!(target_arch = "wasm32") => RendererBackend::WebGl2,
            wgpu::Backend::Gl => RendererBackend::OpenGl,
            wgpu::Backend::Metal => RendererBackend::Metal,
            wgpu::Backend::Vulkan => RendererBackend::Vulkan,
            wgpu::Backend::Dx12 => RendererBackend::DirectX12,
            _ => RendererBackend::Unknown,
        }
    }

    #[must_use]
    pub fn adapter_name(&self) -> &str {
        &self.adapter_info.name
    }

    #[must_use]
    pub fn is_hardware_accelerated(&self) -> bool {
        !matches!(self.adapter_info.device_type, wgpu::DeviceType::Cpu)
    }

    pub fn check_health(&self) -> Result<(), GpuError> {
        self.device_loss.error().map_or(Ok(()), Err)
    }

    pub fn reset_scene_diagnostics(&mut self) {
        forget_scene_mesh(&mut self.cached_mesh);
        self.static_mesh_revision = 0;
        self.cumulative_geometry_upload_bytes = 0;
        self.cumulative_geometry_buffer_uploads = 0;
        self.cumulative_dynamic_index_upload_bytes = 0;
        self.cumulative_dynamic_index_buffer_uploads = 0;
        self.cumulative_dynamic_style_upload_bytes = 0;
        self.cumulative_dynamic_style_buffer_uploads = 0;
        self.cumulative_flow_upload_bytes = 0;
        self.cumulative_uniform_upload_bytes = 0;
        self.cumulative_lod_uniform_upload_bytes = 0;
        self.cache_hits = 0;
        self.cache_misses = 0;
        self.cache_evictions = 0;
        self.last_lod_uniform = None;
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        let width = width.max(1);
        let height = height.max(1);
        if !surface_size_changed((self.config.width, self.config.height), (width, height)) {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
    }

    pub fn render(
        &mut self,
        snapshot: &SceneSnapshot,
        camera: &Camera,
        frame: &ProtocolFrame,
    ) -> Result<GpuRenderReport, GpuError> {
        self.check_health()?;
        let cache_key = MeshCacheKey::new(snapshot, frame);
        let mesh_rebuilt = static_mesh_rebuild_required(self.cached_mesh.as_ref(), cache_key);
        let mut mesh_build_ms = 0.0;
        let mut geometry_upload_bytes = 0_u64;
        let mut geometry_buffer_uploads = 0_u32;
        let mut dynamic_style_upload_bytes = 0_u64;
        let mut dynamic_style_buffer_uploads = 0_u32;
        if mesh_rebuilt {
            self.cache_misses += 1;
            if self.cached_mesh.is_some() {
                self.cache_evictions += 1;
            }
            let started = monotonic_ms();
            let mesh = build_mesh(snapshot, &self.glyph_atlas);
            mesh_build_ms = (monotonic_ms() - started).max(0.0) as f32;
            self.ensure_vertex_capacity(mesh.vertices.len());
            // A scene rebuild can reuse the vertex capacity. Reinitialize the
            // style stream so the fresh per-span cache and GPU contents both
            // begin at the canonical visible style.
            self.style_buffer = create_style_buffer(&self.device, self.vertex_capacity);
            if !mesh.vertices.is_empty() {
                geometry_upload_bytes =
                    (mesh.vertices.len() * std::mem::size_of::<Vertex>()) as u64;
                geometry_buffer_uploads = 1;
                self.queue.write_buffer(
                    &self.vertex_buffer,
                    0,
                    bytemuck::cast_slice(&mesh.vertices),
                );
            }
            let span_styles = vec![VertexStyle::visible(); mesh.style_spans.len()];
            self.cached_mesh = Some(CachedMesh {
                key: cache_key,
                mesh,
                span_styles,
            });
            self.static_mesh_revision = self.static_mesh_revision.wrapping_add(1);
        } else {
            self.cache_hits += 1;
        }
        self.cumulative_geometry_upload_bytes += geometry_upload_bytes;
        self.cumulative_geometry_buffer_uploads += u64::from(geometry_buffer_uploads);
        let camera_uniform = CameraUniform::from_camera(camera);
        self.queue
            .write_buffer(&self.camera_buffer, 0, bytemuck::bytes_of(&camera_uniform));
        let uniform_upload_bytes = std::mem::size_of::<CameraUniform>() as u64;
        self.cumulative_uniform_upload_bytes += uniform_upload_bytes;
        let lod_uniform = LodUniform::from_frame(
            &self
                .cached_mesh
                .as_ref()
                .expect("mesh cache is populated before LOD selection")
                .mesh,
            frame,
        );
        let lod_uniform_upload_bytes = if self.last_lod_uniform != Some(lod_uniform) {
            self.queue
                .write_buffer(&self.lod_buffer, 0, bytemuck::bytes_of(&lod_uniform));
            self.last_lod_uniform = Some(lod_uniform);
            std::mem::size_of::<LodUniform>() as u64
        } else {
            0
        };
        self.cumulative_lod_uniform_upload_bytes += lod_uniform_upload_bytes;

        let active_stream = build_active_mesh_stream(
            &self
                .cached_mesh
                .as_ref()
                .expect("mesh cache is populated before active-range selection")
                .mesh,
            frame,
        );
        {
            let (style_uploads, style_changes) = {
                let cached = self
                    .cached_mesh
                    .as_ref()
                    .expect("mesh cache is populated before styling");
                build_style_uploads(
                    &cached.mesh,
                    &cached.span_styles,
                    &active_stream.span_styles,
                )
            };
            for upload in &style_uploads {
                dynamic_style_upload_bytes +=
                    (upload.values.len() * std::mem::size_of::<VertexStyle>()) as u64;
                dynamic_style_buffer_uploads += 1;
                self.queue.write_buffer(
                    &self.style_buffer,
                    (upload.start * std::mem::size_of::<VertexStyle>()) as u64,
                    bytemuck::cast_slice(&upload.values),
                );
            }
            let cached = self
                .cached_mesh
                .as_mut()
                .expect("mesh cache is populated before style-cache update");
            for (span_index, style) in style_changes {
                cached.span_styles[span_index] = style;
            }
        }
        self.cumulative_dynamic_style_upload_bytes += dynamic_style_upload_bytes;
        self.cumulative_dynamic_style_buffer_uploads += u64::from(dynamic_style_buffer_uploads);

        let index_reallocated = self.ensure_index_capacity(active_stream.indices.len());
        let index_changed =
            mesh_rebuilt || index_reallocated || active_stream.indices != self.active_indices;
        let mut dynamic_index_upload_bytes = 0_u64;
        let mut dynamic_index_buffer_uploads = 0_u32;
        if index_changed && !active_stream.indices.is_empty() {
            dynamic_index_upload_bytes =
                (active_stream.indices.len() * std::mem::size_of::<u32>()) as u64;
            dynamic_index_buffer_uploads = 1;
            self.queue.write_buffer(
                &self.index_buffer,
                0,
                bytemuck::cast_slice(&active_stream.indices),
            );
        }
        self.active_indices = active_stream.indices;
        self.cumulative_dynamic_index_upload_bytes += dynamic_index_upload_bytes;
        self.cumulative_dynamic_index_buffer_uploads += u64::from(dynamic_index_buffer_uploads);

        self.flow_vertices =
            build_flow_vertices(snapshot, frame, std::mem::take(&mut self.flow_vertices));
        let flow_vertex_count = self.flow_vertices.len() as u32;
        let mut flow_upload_bytes = 0_u64;
        if !self.flow_vertices.is_empty() {
            self.ensure_flow_vertex_capacity(self.flow_vertices.len());
            flow_upload_bytes = (self.flow_vertices.len()
                * (std::mem::size_of::<Vertex>() + std::mem::size_of::<VertexStyle>()))
                as u64;
            self.queue.write_buffer(
                &self.flow_vertex_buffer,
                0,
                bytemuck::cast_slice(&self.flow_vertices),
            );
            let flow_styles = vec![VertexStyle::visible(); self.flow_vertices.len()];
            self.queue.write_buffer(
                &self.flow_style_buffer,
                0,
                bytemuck::cast_slice(&flow_styles),
            );
        }
        self.cumulative_flow_upload_bytes += flow_upload_bytes;
        let mesh = &self
            .cached_mesh
            .as_ref()
            .expect("mesh cache is populated before rendering")
            .mesh;
        let output = match self.surface.get_current_texture() {
            Ok(output) => output,
            Err(wgpu::SurfaceError::Lost) => return Err(GpuError::SurfaceLost),
            Err(wgpu::SurfaceError::Outdated) => {
                self.surface.configure(&self.device, &self.config);
                self.surface.get_current_texture()?
            }
            Err(error) => return Err(error.into()),
        };
        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("okie-atlas-encoder"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("okie-atlas-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(CLEAR_COLOR),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.resources_bind_group, &[]);
            pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
            pass.set_vertex_buffer(1, self.style_buffer.slice(..));
            pass.set_index_buffer(self.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            if active_stream.path_index_count > 0 {
                pass.draw_indexed(0..active_stream.path_index_count, 0, 0..1);
            }
            if flow_vertex_count > 0 {
                pass.set_vertex_buffer(0, self.flow_vertex_buffer.slice(..));
                pass.set_vertex_buffer(1, self.flow_style_buffer.slice(..));
                pass.draw(0..flow_vertex_count, 0..1);
                pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
                pass.set_vertex_buffer(1, self.style_buffer.slice(..));
            }
            let active_index_count = self.active_indices.len() as u32;
            if active_index_count > active_stream.path_index_count {
                pass.draw_indexed(active_stream.path_index_count..active_index_count, 0, 0..1);
            }
        }
        self.queue.submit(Some(encoder.finish()));
        output.present();
        let draw_range_count = u32::from(active_stream.path_index_count > 0)
            + u32::from(self.active_indices.len() as u32 > active_stream.path_index_count)
            + u32::from(flow_vertex_count > 0);
        Ok(GpuRenderReport {
            mesh_stats: mesh.stats,
            mesh_rebuilt,
            mesh_build_ms,
            geometry_upload_bytes,
            geometry_buffer_uploads,
            static_mesh_revision: self.static_mesh_revision,
            cumulative_geometry_upload_bytes: self.cumulative_geometry_upload_bytes,
            cumulative_geometry_buffer_uploads: self.cumulative_geometry_buffer_uploads,
            dynamic_index_upload_bytes,
            dynamic_index_buffer_uploads,
            cumulative_dynamic_index_upload_bytes: self.cumulative_dynamic_index_upload_bytes,
            cumulative_dynamic_index_buffer_uploads: self.cumulative_dynamic_index_buffer_uploads,
            dynamic_style_upload_bytes,
            dynamic_style_buffer_uploads,
            cumulative_dynamic_style_upload_bytes: self.cumulative_dynamic_style_upload_bytes,
            cumulative_dynamic_style_buffer_uploads: self.cumulative_dynamic_style_buffer_uploads,
            flow_upload_bytes,
            cumulative_flow_upload_bytes: self.cumulative_flow_upload_bytes,
            uniform_upload_bytes,
            cumulative_uniform_upload_bytes: self.cumulative_uniform_upload_bytes,
            lod_uniform_upload_bytes,
            cumulative_lod_uniform_upload_bytes: self.cumulative_lod_uniform_upload_bytes,
            partition_total: active_stream.partition_total,
            partition_active: active_stream.partition_active,
            partition_drawn: active_stream.partition_active,
            resident_object_count: active_stream.resident_object_count,
            resident_path_count: active_stream.resident_path_count,
            cache_hits: self.cache_hits,
            cache_misses: self.cache_misses,
            cache_evictions: self.cache_evictions,
            draw_range_count,
            draw_calls: draw_range_count,
        })
    }

    fn ensure_vertex_capacity(&mut self, required: usize) {
        if required <= self.vertex_capacity {
            return;
        }
        self.vertex_capacity = required.next_power_of_two();
        self.vertex_buffer = create_vertex_buffer(&self.device, self.vertex_capacity);
        self.style_buffer = create_style_buffer(&self.device, self.vertex_capacity);
    }

    fn ensure_index_capacity(&mut self, required: usize) -> bool {
        if required <= self.index_capacity {
            return false;
        }
        self.index_capacity = required.next_power_of_two();
        self.index_buffer = create_index_buffer(&self.device, self.index_capacity);
        true
    }

    fn ensure_flow_vertex_capacity(&mut self, required: usize) {
        if required <= self.flow_vertex_capacity {
            return;
        }
        self.flow_vertex_capacity = required.next_power_of_two();
        self.flow_vertex_buffer = create_vertex_buffer(&self.device, self.flow_vertex_capacity);
        self.flow_style_buffer = create_style_buffer(&self.device, self.flow_vertex_capacity);
    }
}

#[cfg(target_arch = "wasm32")]
fn monotonic_ms() -> f64 {
    web_sys::window()
        .and_then(|window| window.performance())
        .map_or(0.0, |performance| performance.now())
}

#[cfg(not(target_arch = "wasm32"))]
fn monotonic_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64() * 1_000.0)
}

fn create_vertex_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("okie-atlas-vertices"),
        contents: &vec![0_u8; capacity.max(1) * std::mem::size_of::<Vertex>()],
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
    })
}

fn create_style_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
    let styles = vec![VertexStyle::visible(); capacity.max(1)];
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("okie-atlas-vertex-styles"),
        contents: bytemuck::cast_slice(&styles),
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
    })
}

fn create_index_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("okie-atlas-active-indices"),
        contents: &vec![0_u8; capacity.max(1) * std::mem::size_of::<u32>()],
        usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
    })
}

#[derive(Debug)]
struct StyleUpload {
    start: usize,
    values: Vec<VertexStyle>,
}

fn build_style_uploads(
    mesh: &GpuMesh,
    current: &[VertexStyle],
    desired: &[Option<VertexStyle>],
) -> (Vec<StyleUpload>, Vec<(usize, VertexStyle)>) {
    let mut uploads: Vec<StyleUpload> = Vec::new();
    let mut changes = Vec::new();
    for (span_index, desired) in desired.iter().copied().enumerate() {
        let Some(desired) = desired else {
            continue;
        };
        if current.get(span_index).copied() == Some(desired) {
            continue;
        }
        let span = &mesh.style_spans[span_index];
        changes.push((span_index, desired));
        if span.start == span.end {
            continue;
        }
        let extend_existing = uploads
            .last()
            .is_some_and(|upload| upload.start + upload.values.len() == span.start);
        if !extend_existing {
            uploads.push(StyleUpload {
                start: span.start,
                values: Vec::with_capacity(span.end - span.start),
            });
        }
        let upload = uploads.last_mut().expect("a style upload exists");
        let new_length = upload.values.len() + span.end - span.start;
        upload.values.resize(new_length, desired);
    }
    (uploads, changes)
}

/// Scene colors are authored as CSS/display-space values. Rendering them into
/// an sRGB attachment would linear-to-sRGB encode them a second time. This is
/// especially visible in wgpu's WebGL2 backend, whose sRGB presentation pass
/// turns the near-black canvas slate grey. Prefer the display-space UNORM
/// swapchain format on every backend so WebGPU and WebGL2 have the same output.
#[cfg(any(target_arch = "wasm32", test))]
fn select_surface_format(formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    formats
        .iter()
        .copied()
        .find(|format| {
            matches!(
                format,
                wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Rgba8Unorm
            )
        })
        .or_else(|| formats.iter().copied().find(|format| !format.is_srgb()))
        .or_else(|| formats.first().copied())
}

/// A full scene load starts a new engine, whose geometry epoch restarts at 0, and a view's
/// scenes share one id and revision (a bootstrap scene and its enrichment, CLA-590). The
/// cache key cannot tell the new scene from the old one, so a load drops the old mesh.
fn forget_scene_mesh(cached: &mut Option<CachedMesh>) {
    *cached = None;
}

#[cfg(test)]
mod tests {
    use atlas_engine::{Camera, CameraLimits, ProtocolEngine, Vec2, Viewport};
    use atlas_protocol::SceneSnapshot;

    use super::*;

    #[test]
    fn query_backend_selection_is_explicit() {
        assert_eq!(
            BackendPreference::from_query(Some("webgpu")),
            BackendPreference::WebGpu
        );
        assert_eq!(
            BackendPreference::from_query(Some("webgl2")),
            BackendPreference::WebGl2
        );
        assert_eq!(
            BackendPreference::from_query(Some("unsupported")),
            BackendPreference::Auto
        );
    }

    #[test]
    fn display_space_surface_format_avoids_double_srgb_encoding() {
        let formats = [
            wgpu::TextureFormat::Rgba8UnormSrgb,
            wgpu::TextureFormat::Rgba8Unorm,
        ];
        assert_eq!(
            select_surface_format(&formats),
            Some(wgpu::TextureFormat::Rgba8Unorm)
        );
    }

    #[test]
    fn device_loss_state_is_fatal_and_preserves_reason() {
        let state = DeviceLossState::default();
        assert!(state.error().is_none());
        state.mark(wgpu::DeviceLostReason::Unknown, "driver reset".into());
        assert!(matches!(
            state.error(),
            Some(GpuError::DeviceLost(message)) if message.contains("driver reset")
        ));
    }

    #[test]
    fn mesh_cache_key_survives_camera_only_frames() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let camera = Camera::new(
            Vec2::new(810.0, 450.0),
            0.8,
            Viewport::new(1200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        let mut engine = ProtocolEngine::try_new(snapshot.clone(), camera).unwrap();
        let first = engine.prepare_frame(RendererBackend::Headless);
        let first_key = MeshCacheKey::new(&snapshot, &first);
        engine.pan_screen(Vec2::new(0.25, 0.25));
        let second = engine.prepare_frame(RendererBackend::Headless);
        let second_key = MeshCacheKey::new(&snapshot, &second);
        assert_eq!(first_key, second_key);
        let cached = CachedMesh {
            key: first_key,
            mesh: GpuMesh::default(),
            span_styles: Vec::new(),
        };
        assert!(!static_mesh_rebuild_required(Some(&cached), second_key));
        assert!(build_flow_vertices(&snapshot, &second, Vec::new()).is_empty());
    }

    #[test]
    fn flow_phase_uses_dynamic_vertices_without_invalidating_static_mesh() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let camera = Camera::new(
            Vec2::new(810.0, 450.0),
            0.8,
            Viewport::new(1200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        let mut engine = ProtocolEngine::try_new(snapshot.clone(), camera).unwrap();
        let first = engine.prepare_frame(RendererBackend::Headless);
        let mut animated = first.clone();
        animated.paths[0].flow_phase = 0.5;

        assert_eq!(
            MeshCacheKey::new(&snapshot, &first),
            MeshCacheKey::new(&snapshot, &animated)
        );
        assert!(!build_flow_vertices(&snapshot, &animated, Vec::new()).is_empty());
    }

    #[test]
    fn lod_and_visual_state_change_only_the_dynamic_style_stream() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let camera = Camera::new(
            Vec2::new(810.0, 450.0),
            0.4,
            Viewport::new(1200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        let mut engine = ProtocolEngine::try_new(snapshot.clone(), camera).unwrap();
        engine.tick(0.0);
        let first = engine.prepare_frame(RendererBackend::Headless);
        let mesh = build_mesh(&snapshot, &GlyphAtlas::new());
        let first_styles = crate::build_style_vertices(&mesh, &first);

        engine.camera_mut().set_zoom(2.4);
        engine.tick(0.0);
        let mut transitioning = engine.prepare_frame(RendererBackend::Headless);
        transitioning.objects[0].emphasis = 1.0;
        transitioning.objects[0].opacity *= 0.35;
        let transitioning_styles = crate::build_style_vertices(&mesh, &transitioning);

        assert_eq!(
            MeshCacheKey::new(&snapshot, &first),
            MeshCacheKey::new(&snapshot, &transitioning)
        );
        assert_ne!(first_styles, transitioning_styles);
    }

    #[test]
    fn a_full_scene_load_with_the_same_id_and_revision_draws_its_own_mesh() {
        // Mirrors `GpuRenderer::render`: rebuild when the key changes, then select ranges.
        fn draw(
            cached: &mut Option<CachedMesh>,
            snapshot: &SceneSnapshot,
            frame: &ProtocolFrame,
        ) -> bool {
            let key = MeshCacheKey::new(snapshot, frame);
            let rebuilt = static_mesh_rebuild_required(cached.as_ref(), key);
            if rebuilt {
                *cached = Some(CachedMesh {
                    key,
                    mesh: build_mesh(snapshot, &GlyphAtlas::new()),
                    span_styles: Vec::new(),
                });
            }
            rebuilt
        }
        let camera = Camera::new(
            Vec2::new(810.0, 450.0),
            0.8,
            Viewport::new(1200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        let bootstrap: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        // A different scene under the same id and revision, as the enrichment of a view is.
        let mut enriched = bootstrap.clone();
        enriched.paths.clear();
        assert_eq!(
            (&bootstrap.scene_id, bootstrap.revision),
            (&enriched.scene_id, enriched.revision)
        );
        let bootstrap_frame = ProtocolEngine::try_new(bootstrap.clone(), camera)
            .unwrap()
            .prepare_frame(RendererBackend::Headless);
        let mut engine = ProtocolEngine::try_new(enriched.clone(), camera).unwrap();
        let enriched_frame = engine.prepare_frame(RendererBackend::Headless);
        assert_eq!(
            MeshCacheKey::new(&bootstrap, &bootstrap_frame),
            MeshCacheKey::new(&enriched, &enriched_frame),
            "the key alone cannot tell the scenes apart"
        );

        let mut cached = None;
        assert!(draw(&mut cached, &bootstrap, &bootstrap_frame));
        assert!(cached.as_ref().unwrap().mesh.path_vertex_count > 0);
        forget_scene_mesh(&mut cached);
        assert!(draw(&mut cached, &enriched, &enriched_frame));
        let expected = build_mesh(&enriched, &GlyphAtlas::new());
        let mesh = &cached.as_ref().unwrap().mesh;
        assert_eq!(mesh.path_vertex_count, 0);
        assert_eq!(mesh.vertices.len(), expected.vertices.len());
        let stream = build_active_mesh_stream(mesh, &enriched_frame);
        assert!(stream.partition_active > 0);
        assert!(!stream.indices.is_empty());
        assert!(
            stream
                .indices
                .iter()
                .all(|&index| (index as usize) < expected.vertices.len())
        );

        // Camera-only frames of the loaded scene still reuse its mesh.
        engine.pan_screen(Vec2::new(0.25, 0.25));
        let panned = engine.prepare_frame(RendererBackend::Headless);
        assert!(!draw(&mut cached, &enriched, &panned));
    }

    #[test]
    fn identical_surface_sizes_are_deduplicated() {
        assert!(!surface_size_changed((1200, 800), (1200, 800)));
        assert!(surface_size_changed((1200, 800), (1201, 800)));
        assert!(surface_size_changed((1200, 800), (1200, 801)));
    }
}
