use atlas_engine::{
    Camera, CameraLimits, ProjectionOverride, ProtocolEngine, ProtocolLodFrame, RendererBackend,
    Vec2, Viewport, VisibilityFilter,
};
use atlas_gpu::{BackendPreference, GpuError, GpuRenderReport, GpuRenderer, MeshStats};
use atlas_protocol::{ScenePatch, SceneSnapshot, Timeline};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

use crate::{DiagnosticsPayload, FrameTimeWindow, PickPayload, apply_host_camera};

#[wasm_bindgen]
pub struct WasmAtlasRenderer {
    canvas: HtmlCanvasElement,
    gpu: Option<GpuRenderer>,
    engine: Option<ProtocolEngine>,
    requested_backend: String,
    viewport: Viewport,
    last_frame_ms: f32,
    last_mesh_stats: MeshStats,
    last_draw_calls: u32,
    last_visible_entities: u32,
    last_visible_relations: u32,
    last_candidate_entities: u32,
    last_candidate_relations: u32,
    last_resident_entities: u32,
    last_resident_relations: u32,
    last_retained_view_reused: bool,
    last_culled_entities: u32,
    last_culled_relations: u32,
    last_mesh_rebuilt: bool,
    last_mesh_build_ms: f32,
    last_geometry_upload_bytes: u64,
    last_geometry_buffer_uploads: u32,
    last_report: GpuRenderReport,
    last_lod: Option<ProtocolLodFrame>,
    frame_times: FrameTimeWindow,
    total_frame_count: u64,
    pointer_anchor: Option<Vec2>,
}

/// Asynchronous because browser adapter/device creation is asynchronous. The
/// frontend can keep returning its synchronous Canvas2D preview while this
/// promise resolves, then swap adapters without changing React state.
#[wasm_bindgen(js_name = createAtlasRenderer)]
pub async fn create_atlas_renderer(
    canvas: HtmlCanvasElement,
    requested_backend: String,
) -> Result<WasmAtlasRenderer, JsValue> {
    console_error_panic_hook::set_once();
    let preference = BackendPreference::from_query(Some(&requested_backend));
    let width = canvas.width().max(1);
    let height = canvas.height().max(1);
    let gpu = GpuRenderer::from_canvas(canvas.clone(), width, height, preference)
        .await
        .map_err(|error| backend_error(&requested_backend, error))?;
    Ok(WasmAtlasRenderer {
        canvas,
        gpu: Some(gpu),
        engine: None,
        requested_backend,
        viewport: Viewport::new(f64::from(width), f64::from(height), 1.0),
        last_frame_ms: 0.0,
        last_mesh_stats: MeshStats::default(),
        last_draw_calls: 0,
        last_visible_entities: 0,
        last_visible_relations: 0,
        last_candidate_entities: 0,
        last_candidate_relations: 0,
        last_resident_entities: 0,
        last_resident_relations: 0,
        last_retained_view_reused: false,
        last_culled_entities: 0,
        last_culled_relations: 0,
        last_mesh_rebuilt: false,
        last_mesh_build_ms: 0.0,
        last_geometry_upload_bytes: 0,
        last_geometry_buffer_uploads: 0,
        last_report: GpuRenderReport::default(),
        last_lod: None,
        frame_times: FrameTimeWindow::default(),
        total_frame_count: 0,
        pointer_anchor: None,
    })
}

#[wasm_bindgen]
impl WasmAtlasRenderer {
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        self.active_backend_name().to_owned()
    }

    #[wasm_bindgen(js_name = setScene)]
    pub fn set_scene(&mut self, value: JsValue) -> Result<(), JsValue> {
        let snapshot: SceneSnapshot = serde_wasm_bindgen::from_value(value)
            .map_err(|error| rejected_call(format!("invalid scene snapshot: {error}")))?;
        let center = Vec2::new(
            f64::from(snapshot.world_bounds.x + snapshot.world_bounds.width / 2.0),
            f64::from(snapshot.world_bounds.y + snapshot.world_bounds.height / 2.0),
        );
        let mut camera = Camera::new(center, 1.0, self.viewport, CameraLimits::default());
        camera.fit_rect(
            atlas_engine::Rect::new(
                f64::from(snapshot.world_bounds.x),
                f64::from(snapshot.world_bounds.y),
                f64::from(snapshot.world_bounds.width),
                f64::from(snapshot.world_bounds.height),
            ),
            48.0,
        );
        self.engine = Some(
            ProtocolEngine::try_new(snapshot, camera)
                .map_err(|error| rejected_call(format!("scene validation failed: {error}")))?,
        );
        if let Some(gpu) = &mut self.gpu {
            gpu.reset_scene_diagnostics();
        }
        self.last_report = GpuRenderReport::default();
        self.frame_times = FrameTimeWindow::default();
        self.total_frame_count = 0;
        Ok(())
    }

    #[wasm_bindgen(js_name = applyPatch)]
    pub fn apply_patch(&mut self, value: JsValue) -> Result<(), JsValue> {
        let patch: ScenePatch = serde_wasm_bindgen::from_value(value)
            .map_err(|error| rejected_call(format!("invalid scene patch: {error}")))?;
        self.engine_mut()?
            .apply_patch(&patch)
            .map_err(|error| rejected_call(format!("scene patch failed: {error}")))
    }

    #[wasm_bindgen(js_name = setTimeline)]
    pub fn set_timeline(&mut self, value: JsValue) -> Result<(), JsValue> {
        let timeline: Timeline = serde_wasm_bindgen::from_value(value)
            .map_err(|error| rejected_call(format!("invalid timeline: {error}")))?;
        self.engine_mut()?
            .set_timeline(timeline)
            .map_err(|error| rejected_call(format!("timeline validation failed: {error}")))
    }

    #[wasm_bindgen(js_name = setVisibility)]
    pub fn set_visibility(&mut self, value: JsValue) -> Result<(), JsValue> {
        let filter: VisibilityFilter = serde_wasm_bindgen::from_value(value)
            .map_err(|error| rejected_call(format!("invalid visibility filter: {error}")))?;
        self.engine_mut()?
            .set_visibility(filter)
            .map_err(|error| rejected_call(format!("visibility filter failed: {error}")))
    }

    #[wasm_bindgen(js_name = setProjectionOverride)]
    pub fn set_projection_override(&mut self, value: JsValue) -> Result<(), JsValue> {
        let projection = if value.is_null() || value.is_undefined() {
            None
        } else {
            Some(
                serde_wasm_bindgen::from_value::<ProjectionOverride>(value).map_err(|error| {
                    rejected_call(format!("invalid projection override: {error}"))
                })?,
            )
        };
        self.engine_mut()?
            .set_projection_override(projection)
            .map_err(|error| rejected_call(format!("projection override failed: {error}")))
    }

    #[wasm_bindgen(js_name = setProjectionProgress)]
    pub fn set_projection_progress(&mut self, id: &str, progress: f32) -> Result<(), JsValue> {
        self.engine_mut()?
            .set_projection_override_progress(id, progress)
            .map_err(|error| rejected_call(format!("projection progress failed: {error}")))
    }

    #[wasm_bindgen(js_name = setReducedMotion)]
    pub fn set_reduced_motion(&mut self, reduced_motion: bool) -> Result<(), JsValue> {
        self.engine_mut()?.set_reduced_motion(reduced_motion);
        Ok(())
    }

    #[wasm_bindgen(js_name = visibleScene)]
    pub fn visible_scene(&self) -> Result<JsValue, JsValue> {
        let snapshot = self
            .engine
            .as_ref()
            .ok_or_else(|| rejected_call("setScene must be called first"))?
            .visible_snapshot();
        serde_wasm_bindgen::to_value(&snapshot)
            .map_err(|error| js_error(format!("visible scene serialization failed: {error}")))
    }

    #[wasm_bindgen(js_name = lodState)]
    pub fn lod_state(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.last_lod)
            .map_err(|error| js_error(format!("LOD state serialization failed: {error}")))
    }

    #[wasm_bindgen(js_name = playTimeline)]
    pub fn play_timeline(&mut self) -> Result<(), JsValue> {
        self.engine_mut()?.play_timeline();
        Ok(())
    }

    #[wasm_bindgen(js_name = pauseTimeline)]
    pub fn pause_timeline(&mut self) -> Result<(), JsValue> {
        self.engine_mut()?.pause_timeline();
        Ok(())
    }

    #[wasm_bindgen(js_name = seekTimeline)]
    pub fn seek_timeline(&mut self, position_ms: f64) -> Result<(), JsValue> {
        self.engine_mut()?.seek_timeline(position_ms);
        Ok(())
    }

    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&mut self, x: f64, y: f64, zoom: f64) -> Result<(), JsValue> {
        apply_host_camera(self.engine_mut()?, x, y, zoom);
        Ok(())
    }

    pub fn resize(&mut self, width: f64, height: f64, device_pixel_ratio: f64) {
        self.viewport = Viewport::new(width, height, device_pixel_ratio);
        let physical_width = self.viewport.physical_width();
        let physical_height = self.viewport.physical_height();
        if self.canvas.width() != physical_width {
            self.canvas.set_width(physical_width);
        }
        if self.canvas.height() != physical_height {
            self.canvas.set_height(physical_height);
        }
        if let Some(gpu) = &mut self.gpu {
            gpu.resize(physical_width, physical_height);
        }
        if let Some(engine) = &mut self.engine {
            engine.resize(self.viewport);
        }
    }

    #[wasm_bindgen(js_name = pointerDown)]
    pub fn pointer_down(&mut self, screen_x: f64, screen_y: f64) {
        self.pointer_anchor = Some(Vec2::new(screen_x, screen_y));
    }

    #[wasm_bindgen(js_name = pointerMove)]
    pub fn pointer_move(&mut self, screen_x: f64, screen_y: f64) -> Result<(), JsValue> {
        let next = Vec2::new(screen_x, screen_y);
        if let Some(previous) = self.pointer_anchor {
            self.engine_mut()?.pan_screen(next - previous);
            self.pointer_anchor = Some(next);
        }
        Ok(())
    }

    #[wasm_bindgen(js_name = pointerUp)]
    pub fn pointer_up(&mut self) {
        self.pointer_anchor = None;
    }

    #[wasm_bindgen(js_name = zoomAt)]
    pub fn zoom_at(&mut self, screen_x: f64, screen_y: f64, factor: f64) -> Result<(), JsValue> {
        self.engine_mut()?
            .zoom_at(Vec2::new(screen_x, screen_y), factor);
        Ok(())
    }

    pub fn render(&mut self, time_ms: f64) -> Result<(), JsValue> {
        let started = performance_now();
        let gpu = self
            .gpu
            .as_mut()
            .ok_or_else(|| js_error("renderer has been disposed"))?;
        let engine = self
            .engine
            .as_mut()
            .ok_or_else(|| rejected_call("setScene must be called before render"))?;
        engine.tick(time_ms);
        let mut frame = engine.prepare_frame(gpu.backend());
        self.last_lod = frame.lod.clone();
        let report = gpu
            .render(engine.snapshot(), engine.camera(), &frame)
            .map_err(|error| js_error(format!("render failed: {error}")))?;
        let elapsed = (performance_now() - started).max(0.0) as f32;
        frame.diagnostics.frame_time_ms = elapsed;
        self.last_frame_ms = elapsed;
        self.last_draw_calls = report.draw_calls;
        self.last_visible_entities = frame.diagnostics.visible_nodes;
        self.last_visible_relations = frame.diagnostics.visible_edges;
        self.last_candidate_entities = frame.diagnostics.candidate_nodes;
        self.last_candidate_relations = frame.diagnostics.candidate_edges;
        self.last_resident_entities = frame.diagnostics.resident_nodes;
        self.last_resident_relations = frame.diagnostics.resident_edges;
        self.last_retained_view_reused = frame.diagnostics.retained_view_reused;
        self.last_culled_entities = frame.diagnostics.culled_nodes;
        self.last_culled_relations = frame.diagnostics.culled_edges;
        self.last_mesh_stats = report.mesh_stats;
        self.last_mesh_rebuilt = report.mesh_rebuilt;
        self.last_mesh_build_ms = report.mesh_build_ms;
        self.last_geometry_upload_bytes = report.geometry_upload_bytes;
        self.last_geometry_buffer_uploads = report.geometry_buffer_uploads;
        self.last_report = report;
        self.frame_times.push(elapsed);
        self.total_frame_count = self.total_frame_count.saturating_add(1);
        Ok(())
    }

    pub fn pick(&mut self, screen_x: f64, screen_y: f64) -> Result<JsValue, JsValue> {
        let payload = self
            .engine_mut()?
            .select_at(Vec2::new(screen_x, screen_y), 7.0)
            .map(PickPayload::from);
        serde_wasm_bindgen::to_value(&payload)
            .map_err(|error| js_error(format!("pick serialization failed: {error}")))
    }

    pub fn diagnostics(&self) -> Result<JsValue, JsValue> {
        if let Some(gpu) = &self.gpu {
            gpu.check_health()
                .map_err(|error| js_error(format!("renderer health check failed: {error}")))?;
        }
        let entity_count = self
            .engine
            .as_ref()
            .map(|engine| engine.snapshot().objects.len() as u32)
            .unwrap_or(0);
        let relation_count = self
            .engine
            .as_ref()
            .map(|engine| engine.snapshot().paths.len() as u32)
            .unwrap_or(0);
        let payload = DiagnosticsPayload {
            requested_backend: self.requested_backend.clone(),
            active_backend: self.active_backend_name().to_owned(),
            gpu_accelerated: self
                .gpu
                .as_ref()
                .is_some_and(GpuRenderer::is_hardware_accelerated),
            entity_count,
            relation_count,
            last_frame_ms: self.last_frame_ms,
            frame_p50_ms: self.frame_times.percentile(0.50),
            frame_p95_ms: self.frame_times.percentile(0.95),
            frame_p99_ms: self.frame_times.percentile(0.99),
            frame_sample_count: self.frame_times.len() as u32,
            total_frame_count: self.total_frame_count,
            frame_window_includes_initial_build: FrameTimeWindow::includes_first_sample(
                self.total_frame_count,
            ),
            message: if self.last_mesh_stats.text_primitives_deferred > 0 {
                "GPU geometry active; text atlas is the next renderer milestone".into()
            } else {
                format!("{} GPU renderer active", self.active_backend_name())
            },
            visible_entities: self.last_visible_entities,
            visible_relations: self.last_visible_relations,
            candidate_entities: self.last_candidate_entities,
            candidate_relations: self.last_candidate_relations,
            resident_entities: self.last_resident_entities,
            resident_relations: self.last_resident_relations,
            retained_view_reused: self.last_retained_view_reused,
            culled_entities: self.last_culled_entities,
            culled_relations: self.last_culled_relations,
            draw_calls: self.last_draw_calls,
            mesh_rebuilt: self.last_mesh_rebuilt,
            mesh_build_ms: self.last_mesh_build_ms,
            geometry_upload_bytes: self.last_geometry_upload_bytes,
            geometry_buffer_uploads: self.last_geometry_buffer_uploads,
            static_mesh_revision: self.last_report.static_mesh_revision,
            static_geometry_upload_bytes: self.last_report.geometry_upload_bytes,
            static_geometry_buffer_uploads: self.last_report.geometry_buffer_uploads,
            cumulative_static_geometry_upload_bytes: self
                .last_report
                .cumulative_geometry_upload_bytes,
            cumulative_static_geometry_buffer_uploads: self
                .last_report
                .cumulative_geometry_buffer_uploads,
            dynamic_index_upload_bytes: self.last_report.dynamic_index_upload_bytes,
            dynamic_index_buffer_uploads: self.last_report.dynamic_index_buffer_uploads,
            cumulative_dynamic_index_upload_bytes: self
                .last_report
                .cumulative_dynamic_index_upload_bytes,
            cumulative_dynamic_index_buffer_uploads: self
                .last_report
                .cumulative_dynamic_index_buffer_uploads,
            dynamic_style_upload_bytes: self.last_report.dynamic_style_upload_bytes,
            dynamic_style_buffer_uploads: self.last_report.dynamic_style_buffer_uploads,
            cumulative_dynamic_style_upload_bytes: self
                .last_report
                .cumulative_dynamic_style_upload_bytes,
            cumulative_dynamic_style_buffer_uploads: self
                .last_report
                .cumulative_dynamic_style_buffer_uploads,
            flow_upload_bytes: self.last_report.flow_upload_bytes,
            cumulative_flow_upload_bytes: self.last_report.cumulative_flow_upload_bytes,
            uniform_upload_bytes: self.last_report.uniform_upload_bytes,
            cumulative_uniform_upload_bytes: self.last_report.cumulative_uniform_upload_bytes,
            lod_uniform_upload_bytes: self.last_report.lod_uniform_upload_bytes,
            cumulative_lod_uniform_upload_bytes: self
                .last_report
                .cumulative_lod_uniform_upload_bytes,
            resident_partition_total: self.last_report.partition_total,
            resident_partition_active: self.last_report.partition_active,
            resident_partition_drawn: self.last_report.partition_drawn,
            resident_object_count: self.last_report.resident_object_count,
            resident_path_count: self.last_report.resident_path_count,
            partition_cache_hits: self.last_report.cache_hits,
            partition_cache_misses: self.last_report.cache_misses,
            partition_cache_evictions: self.last_report.cache_evictions,
            draw_range_count: self.last_report.draw_range_count,
            glyph_quads: self.last_mesh_stats.glyph_quads,
            deferred_text_primitives: self.last_mesh_stats.text_primitives_deferred,
            deferred_icon_primitives: self.last_mesh_stats.icon_primitives_deferred,
        };
        serde_wasm_bindgen::to_value(&payload)
            .map_err(|error| js_error(format!("diagnostics serialization failed: {error}")))
    }

    pub fn dispose(&mut self) {
        self.engine = None;
        self.gpu = None;
        self.pointer_anchor = None;
    }

    fn engine_mut(&mut self) -> Result<&mut ProtocolEngine, JsValue> {
        self.engine
            .as_mut()
            .ok_or_else(|| rejected_call("setScene must be called first"))
    }

    fn active_backend_name(&self) -> &'static str {
        match self.gpu.as_ref().map(GpuRenderer::backend) {
            Some(RendererBackend::WebGpu) => "webgpu",
            Some(RendererBackend::WebGl2) => "webgl2",
            Some(RendererBackend::Metal) => "metal",
            Some(RendererBackend::Vulkan) => "vulkan",
            Some(RendererBackend::DirectX12) => "directx12",
            Some(RendererBackend::OpenGl) => "opengl",
            Some(RendererBackend::Headless) => "headless",
            Some(RendererBackend::Unknown) => "unknown",
            None => "unsupported",
        }
    }
}

fn backend_error(requested: &str, error: GpuError) -> JsValue {
    js_error(format!(
        "requested renderer backend `{requested}` is unsupported: {error}"
    ))
}

fn js_error(message: impl AsRef<str>) -> JsValue {
    js_sys::Error::new(message.as_ref()).into()
}

/// A call the engine refused: bad input, or a call before the first scene. The
/// renderer is intact, and the host tells this from a lost surface by the error
/// name alone (`REJECTED_CALL_ERROR_NAME` in apps/web/src/renderer/gpuLoss.ts).
fn rejected_call(message: impl AsRef<str>) -> JsValue {
    let error = js_sys::Error::new(message.as_ref());
    error.set_name("AtlasRejectedCall");
    error.into()
}

fn performance_now() -> f64 {
    web_sys::window()
        .and_then(|window| window.performance())
        .map_or(0.0, |performance| performance.now())
}
