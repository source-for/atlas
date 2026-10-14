use atlas_engine::{Rect, Vec2};
use atlas_protocol::TextAlign;
use fontdue::{Font, FontSettings};

const IBM_PLEX_SANS_REGULAR: &[u8] =
    include_bytes!("../../../third_party/fonts/ibm-plex-v6.4.2/IBMPlexSans-Regular.ttf");
const IBM_PLEX_SANS_MEDIUM: &[u8] =
    include_bytes!("../../../third_party/fonts/ibm-plex-v6.4.2/IBMPlexSans-Medium.ttf");
const IBM_PLEX_SANS_SEMIBOLD: &[u8] =
    include_bytes!("../../../third_party/fonts/ibm-plex-v6.4.2/IBMPlexSans-SemiBold.ttf");
const IBM_PLEX_MONO_REGULAR: &[u8] =
    include_bytes!("../../../third_party/fonts/ibm-plex-v6.4.2/IBMPlexMono-Regular.ttf");
const IBM_PLEX_MONO_SEMIBOLD: &[u8] =
    include_bytes!("../../../third_party/fonts/ibm-plex-v6.4.2/IBMPlexMono-SemiBold.ttf");

const FIRST_GLYPH: u8 = 32;
const GLYPH_PIXELS: u32 = 64;
const GLYPH_PADDING: u32 = 5;
const RASTER_SIZE: f32 = 48.0;
const PAGE_COLUMNS: u32 = 16;
const PAGE_GLYPHS: u32 = 96;
const GLYPH_PAGES: u32 = 2;
const FACE_GLYPHS: u32 = PAGE_GLYPHS * GLYPH_PAGES;
const ATLAS_COLUMNS: u32 = PAGE_COLUMNS * GLYPH_PAGES;
const GLYPH_ROWS: u32 = PAGE_GLYPHS / PAGE_COLUMNS;
const FACE_COUNT: u32 = 5;
const ATLAS_ROWS: u32 = GLYPH_ROWS * FACE_COUNT;
const SPACE_GLYPH_INDEX: u32 = 0;
const ELLIPSIS_GLYPH_INDEX: u32 = PAGE_GLYPHS - 1;
const FALLBACK_GLYPH_INDEX: u32 = FACE_GLYPHS - 1;

/// The second page of every face, in code point order: slot `PAGE_GLYPHS + index`.
/// U+FFFD comes last and is drawn for every character without a slot of its own.
const EXTENDED_GLYPHS: [char; PAGE_GLYPHS as usize] = [
    '¡', '£', '¥', '§', '©', '«', '®', '°', '±', '²', '³', 'µ', '·', '»', '¿', 'À', //
    'Á', 'Â', 'Ã', 'Ä', 'Å', 'Æ', 'Ç', 'È', 'É', 'Ê', 'Ë', 'Ì', 'Í', 'Î', 'Ï', 'Ð', //
    'Ñ', 'Ò', 'Ó', 'Ô', 'Õ', 'Ö', '×', 'Ø', 'Ù', 'Ú', 'Û', 'Ü', 'Ý', 'Þ', 'ß', 'à', //
    'á', 'â', 'ã', 'ä', 'å', 'æ', 'ç', 'è', 'é', 'ê', 'ë', 'ì', 'í', 'î', 'ï', 'ð', //
    'ñ', 'ò', 'ó', 'ô', 'õ', 'ö', '÷', 'ø', 'ù', 'ú', 'û', 'ü', 'ý', 'þ', 'ÿ', '–', //
    '—', '‘', '’', '“', '”', '•', '€', '←', '↑', '→', '↓', '−', '≠', '≤', '≥', '\u{fffd}',
];

/// Whitespace the atlas draws with the space slot, as Canvas `fillText` does.
const SPACE_ALIASES: [char; 5] = ['\t', '\n', '\u{c}', '\r', '\u{a0}'];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FontFace {
    SansRegular = 0,
    SansMedium = 1,
    SansSemibold = 2,
    MonoRegular = 3,
    MonoSemibold = 4,
}

impl FontFace {
    fn from_family(value: &str) -> Self {
        let lower = value.to_ascii_lowercase();
        let mono = lower.contains("mono");
        let semibold =
            lower.contains("semibold") || lower.contains("600") || lower.contains("bold");
        let medium = lower.contains("medium") || lower.contains("500");
        match (mono, medium, semibold) {
            (true, _, false) => Self::MonoRegular,
            (true, _, true) => Self::MonoSemibold,
            (false, _, true) => Self::SansSemibold,
            (false, true, false) => Self::SansMedium,
            (false, false, false) => Self::SansRegular,
        }
    }

    const fn atlas_row_offset(self) -> u32 {
        self as u32 * GLYPH_ROWS
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct GlyphMetric {
    width: u32,
    height: u32,
    xmin: i32,
    ymin: i32,
    advance: f32,
    atlas_x: u32,
    atlas_y: u32,
}

fn glyph_count(value: &str) -> usize {
    value.chars().count()
}

fn path_candidate(root: Option<&str>, tail: &[&str]) -> String {
    match root {
        Some(root) => format!("{root}/…/{}", tail.join("/")),
        None => format!("…/{}", tail.join("/")),
    }
}

fn fit_text_content(content: &str, capacity: usize) -> String {
    if glyph_count(content) <= capacity {
        return content.to_owned();
    }
    if capacity == 0 {
        return String::new();
    }
    if capacity == 1 {
        return "…".into();
    }

    if content.contains('/') && !content.chars().any(char::is_whitespace) {
        let segments: Vec<_> = content
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect();
        if segments.len() > 1 {
            let root = segments[0];
            for index in 1..segments.len() {
                let rooted = path_candidate(Some(root), &segments[index..]);
                if glyph_count(&rooted) <= capacity {
                    return rooted;
                }
            }
            for index in 1..segments.len() {
                let unrooted = path_candidate(None, &segments[index..]);
                if glyph_count(&unrooted) <= capacity {
                    return unrooted;
                }
            }
            let filename = segments.last().expect("path has a filename");
            let suffix: String = filename
                .chars()
                .rev()
                .take(capacity - 1)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            return format!("…{suffix}");
        }
    }

    let prefix: String = content.chars().take(capacity - 1).collect();
    if !content.chars().any(char::is_whitespace) {
        return format!("{prefix}…");
    }
    let complete_words = prefix
        .char_indices()
        .rfind(|(_, character)| character.is_whitespace())
        .map_or("", |(index, _)| prefix[..index].trim_end());
    if complete_words.is_empty() {
        "…".into()
    } else {
        format!("{complete_words}…")
    }
}

fn glyph_slot(character: char) -> Option<u32> {
    if character == '…' {
        Some(ELLIPSIS_GLYPH_INDEX)
    } else if character.is_ascii() && !character.is_ascii_control() {
        Some(u32::from(character as u8 - FIRST_GLYPH))
    } else if SPACE_ALIASES.contains(&character) {
        Some(SPACE_GLYPH_INDEX)
    } else {
        EXTENDED_GLYPHS
            .binary_search(&character)
            .ok()
            .map(|index| PAGE_GLYPHS + index as u32)
    }
}

fn glyph_index(character: char) -> u32 {
    glyph_slot(character).unwrap_or(FALLBACK_GLYPH_INDEX)
}

fn slot_character(slot: u32) -> char {
    if slot == ELLIPSIS_GLYPH_INDEX {
        '…'
    } else if slot < PAGE_GLYPHS {
        char::from(FIRST_GLYPH + slot as u8)
    } else {
        EXTENDED_GLYPHS[(slot - PAGE_GLYPHS) as usize]
    }
}

/// The first page keeps the cells it had as the whole atlas; later pages sit to
/// its right, so widening the texture moves no existing texel.
const fn slot_cell(face: FontFace, slot: u32) -> (u32, u32) {
    let within_page = slot % PAGE_GLYPHS;
    (
        (slot / PAGE_GLYPHS) * PAGE_COLUMNS + within_page % PAGE_COLUMNS,
        face.atlas_row_offset() + within_page / PAGE_COLUMNS,
    )
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlyphQuad {
    pub rect: Rect,
    pub uv_min: [f32; 2],
    pub uv_max: [f32; 2],
}

/// A bundled, family-aware glyph atlas rasterized once from pinned OFL IBM Plex
/// Sans and IBM Plex Mono outlines. Layout uses the same retained glyph advances for
/// every frame; there is no browser/system font lookup or per-frame measure.
#[derive(Debug, Clone)]
pub struct GlyphAtlas {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    metrics: Vec<GlyphMetric>,
}

impl Default for GlyphAtlas {
    fn default() -> Self {
        Self::new()
    }
}

impl GlyphAtlas {
    #[must_use]
    pub fn new() -> Self {
        let width = ATLAS_COLUMNS * GLYPH_PIXELS;
        let height = ATLAS_ROWS * GLYPH_PIXELS;
        let mut pixels = vec![0_u8; (width * height) as usize];
        let faces = [
            Font::from_bytes(IBM_PLEX_SANS_REGULAR, FontSettings::default())
                .expect("bundled IBM Plex Sans Regular font must parse"),
            Font::from_bytes(IBM_PLEX_SANS_MEDIUM, FontSettings::default())
                .expect("bundled IBM Plex Sans Medium font must parse"),
            Font::from_bytes(IBM_PLEX_SANS_SEMIBOLD, FontSettings::default())
                .expect("bundled IBM Plex Sans SemiBold font must parse"),
            Font::from_bytes(IBM_PLEX_MONO_REGULAR, FontSettings::default())
                .expect("bundled IBM Plex Mono Regular font must parse"),
            Font::from_bytes(IBM_PLEX_MONO_SEMIBOLD, FontSettings::default())
                .expect("bundled IBM Plex Mono SemiBold font must parse"),
        ];
        let mut metrics = vec![GlyphMetric::default(); (FACE_COUNT * FACE_GLYPHS) as usize];
        for face in [
            FontFace::SansRegular,
            FontFace::SansMedium,
            FontFace::SansSemibold,
            FontFace::MonoRegular,
            FontFace::MonoSemibold,
        ] {
            let font = &faces[face as usize];
            for slot in 0..FACE_GLYPHS {
                let (source_metrics, source_bitmap) =
                    font.rasterize(slot_character(slot), RASTER_SIZE);
                let (column, row) = slot_cell(face, slot);
                let origin_x = column * GLYPH_PIXELS + GLYPH_PADDING;
                let origin_y = row * GLYPH_PIXELS + GLYPH_PADDING;
                let draw_width = source_metrics
                    .width
                    .min((GLYPH_PIXELS - GLYPH_PADDING * 2) as usize)
                    as u32;
                let draw_height = source_metrics
                    .height
                    .min((GLYPH_PIXELS - GLYPH_PADDING * 2) as usize)
                    as u32;
                for y in 0..draw_height {
                    for x in 0..draw_width {
                        pixels[((origin_y + y) * width + origin_x + x) as usize] =
                            source_bitmap[y as usize * source_metrics.width + x as usize];
                    }
                }
                metrics[(face as u32 * FACE_GLYPHS + slot) as usize] = GlyphMetric {
                    width: draw_width,
                    height: draw_height,
                    xmin: source_metrics.xmin,
                    ymin: source_metrics.ymin,
                    advance: source_metrics.advance_width,
                    atlas_x: origin_x,
                    atlas_y: origin_y,
                };
            }
        }
        Self {
            width,
            height,
            pixels,
            metrics,
        }
    }

    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[must_use]
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Whether `character` is drawn as itself (or as a space) rather than as U+FFFD.
    #[must_use]
    pub fn covers(character: char) -> bool {
        glyph_slot(character).is_some()
    }

    #[must_use]
    pub fn layout(
        &self,
        content: &str,
        position: Vec2,
        max_width: f64,
        font_family: &str,
        font_size: f64,
        align: TextAlign,
    ) -> Vec<GlyphQuad> {
        let face = FontFace::from_family(font_family);
        let scale = font_size / f64::from(RASTER_SIZE);
        let text_width = |value: &str| {
            value
                .chars()
                .map(|character| {
                    let slot = glyph_index(character);
                    f64::from(self.metrics[(face as u32 * FACE_GLYPHS + slot) as usize].advance)
                        * scale
                })
                .sum::<f64>()
        };
        let mut display = content.to_owned();
        if text_width(&display) > max_width {
            for capacity in (1..glyph_count(content)).rev() {
                let candidate = fit_text_content(content, capacity);
                if text_width(&candidate) <= max_width {
                    display = candidate;
                    break;
                }
            }
        }
        let characters: Vec<_> = display.chars().collect();
        let line_width = text_width(&display);
        let start_x = match align {
            TextAlign::Start => position.x,
            TextAlign::Center => position.x - line_width / 2.0,
            TextAlign::End => position.x - line_width,
        };
        let mut pen_x = start_x;
        characters
            .into_iter()
            .map(|character| {
                let glyph_index = glyph_index(character);
                let metric = self.metrics[(face as u32 * FACE_GLYPHS + glyph_index) as usize];
                let uv_min = [
                    metric.atlas_x as f32 / self.width as f32,
                    metric.atlas_y as f32 / self.height as f32,
                ];
                let uv_max = [
                    (metric.atlas_x + metric.width) as f32 / self.width as f32,
                    (metric.atlas_y + metric.height) as f32 / self.height as f32,
                ];
                let quad = GlyphQuad {
                    rect: Rect::new(
                        pen_x + f64::from(metric.xmin) * scale,
                        position.y - f64::from(metric.height as i32 + metric.ymin) * scale,
                        f64::from(metric.width) * scale,
                        f64::from(metric.height) * scale,
                    ),
                    uv_min,
                    uv_max,
                };
                pen_x += f64::from(metric.advance) * scale;
                quad
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FACES: [(FontFace, &str, &str); FACE_COUNT as usize] = [
        (FontFace::SansRegular, "sansRegular", "IBM Plex Sans"),
        (FontFace::SansMedium, "sansMedium", "IBM Plex Sans Medium"),
        (
            FontFace::SansSemibold,
            "sansSemibold",
            "IBM Plex Sans SemiBold",
        ),
        (FontFace::MonoRegular, "monoRegular", "IBM Plex Mono"),
        (
            FontFace::MonoSemibold,
            "monoSemibold",
            "IBM Plex Mono SemiBold",
        ),
    ];
    const COMPILER_TABLES_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/scene-compiler/src/glyph-metrics.generated.ts"
    );

    fn metric(atlas: &GlyphAtlas, face: FontFace, slot: u32) -> GlyphMetric {
        atlas.metrics[(face as u32 * FACE_GLYPHS + slot) as usize]
    }

    fn table_rows(values: impl Iterator<Item = String>) -> String {
        values
            .collect::<Vec<_>>()
            .chunks(PAGE_COLUMNS as usize)
            .map(|row| format!("  {},\n", row.join(", ")))
            .collect()
    }

    /// The compiler's copy of the glyph set and advances, exactly as checked in.
    fn compiler_glyph_tables() -> String {
        let atlas = GlyphAtlas::new();
        let em = |face, slot| {
            (f64::from(metric(&atlas, face, slot).advance) / f64::from(RASTER_SIZE) * 1e6).round()
                / 1e6
        };
        let mono = em(FontFace::MonoRegular, SPACE_GLYPH_INDEX);
        let mut out = String::from(
            "// Generated from crates/atlas-gpu/src/glyph.rs. Do not edit by hand.\n\
             // Regenerate: cargo test -p atlas-gpu write_compiler_glyph_tables -- --ignored\n\
             // `cargo test` fails while this file differs from what the atlas would write.\n\n\
             /** Code point drawn by each atlas slot, in slot order. */\n\
             export const glyphCodePoints = [\n",
        );
        out += &table_rows((0..FACE_GLYPHS).map(|slot| (slot_character(slot) as u32).to_string()));
        out += "] as const;\n\n/** Code points drawn with the space slot. */\n";
        out += &format!(
            "export const spaceAliasCodePoints = [{}] as const;\n\n",
            SPACE_ALIASES
                .map(|alias| (alias as u32).to_string())
                .join(", ")
        );
        out += "/** Slot drawn for every code point outside the set (U+FFFD). */\n";
        out += &format!("export const fallbackGlyphSlot = {FALLBACK_GLYPH_INDEX};\n\n");
        out += "/** Every slot of both IBM Plex Mono faces advances by this many em. */\n";
        out += &format!("export const monoGlyphAdvance = {mono};\n");
        for (face, name, _) in FACES {
            if matches!(face, FontFace::MonoRegular | FontFace::MonoSemibold) {
                assert!(
                    (0..FACE_GLYPHS).all(|slot| em(face, slot) == mono),
                    "{name} is no longer fixed-advance; the compiler needs its table"
                );
                continue;
            }
            out += &format!("\n/** Advance in em of each slot of {name}. */\n");
            out += &format!("export const {name}Advances = [\n");
            out += &table_rows((0..FACE_GLYPHS).map(|slot| em(face, slot).to_string()));
            out += "] as const;\n";
        }
        out
    }

    #[test]
    #[ignore = "writes packages/scene-compiler/src/glyph-metrics.generated.ts"]
    fn write_compiler_glyph_tables() {
        std::fs::write(COMPILER_TABLES_PATH, compiler_glyph_tables())
            .expect("generated glyph tables must be writable");
    }

    #[test]
    fn compiler_glyph_tables_are_current() {
        let checked_in =
            std::fs::read(COMPILER_TABLES_PATH).expect("generated glyph tables must be checked in");
        assert!(
            checked_in == compiler_glyph_tables().into_bytes(),
            "glyph-metrics.generated.ts is stale; run \
             `cargo test -p atlas-gpu write_compiler_glyph_tables -- --ignored`"
        );
    }

    fn fnv1a(hash: &mut u64, bytes: &[u8]) {
        for byte in bytes {
            *hash ^= u64::from(*byte);
            *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    /// Hashes pinned on the 1024x1920 single-page atlas (main at 1312c86): per face,
    /// every first-page slot's metrics, cell origin and whole 64x64 cell.
    const FIRST_PAGE_HASHES: [u64; FACE_COUNT as usize] = [
        0xc4c5_c620_5324_9a96,
        0x5710_1860_3e2a_1092,
        0x97cf_8fc7_f3c6_4cab,
        0x1ae1_08b9_92b1_ee59,
        0x5e11_722b_524f_4727,
    ];

    #[test]
    fn first_page_cells_and_metrics_match_the_single_page_atlas() {
        let atlas = GlyphAtlas::new();
        for (face, name, _) in FACES {
            let mut hash = 0xcbf2_9ce4_8422_2325_u64;
            for slot in 0..PAGE_GLYPHS {
                let metric = metric(&atlas, face, slot);
                for value in [
                    metric.width,
                    metric.height,
                    metric.xmin as u32,
                    metric.ymin as u32,
                    metric.advance.to_bits(),
                    metric.atlas_x,
                    metric.atlas_y,
                ] {
                    fnv1a(&mut hash, &value.to_le_bytes());
                }
                let cell_x = metric.atlas_x - GLYPH_PADDING;
                let cell_y = metric.atlas_y - GLYPH_PADDING;
                for y in 0..GLYPH_PIXELS {
                    let start = ((cell_y + y) * atlas.width + cell_x) as usize;
                    fnv1a(
                        &mut hash,
                        &atlas.pixels[start..start + GLYPH_PIXELS as usize],
                    );
                }
            }
            assert_eq!(hash, FIRST_PAGE_HASHES[face as usize], "{name}");
        }
    }

    #[test]
    fn first_page_quads_sample_the_texels_they_sampled_at_1024_wide() {
        let atlas = GlyphAtlas::new();
        let content: String = (0..PAGE_GLYPHS).map(slot_character).collect();
        for (face, name, family) in FACES {
            let quads = atlas.layout(
                &content,
                Vec2::new(0.0, 0.0),
                f64::MAX,
                family,
                f64::from(RASTER_SIZE),
                TextAlign::Start,
            );
            assert_eq!(quads.len(), PAGE_GLYPHS as usize);
            for (slot, quad) in (0..PAGE_GLYPHS).zip(quads) {
                let metric = metric(&atlas, face, slot);
                let x = (slot % 16) * 64 + 5;
                let y = (face as u32 * 6 + slot / 16) * 64 + 5;
                let old_min = [x as f32 / 1024.0, y as f32 / 1920.0];
                let old_max = [
                    (x + metric.width) as f32 / 1024.0,
                    (y + metric.height) as f32 / 1920.0,
                ];
                // Texel coordinate = uv * texture size; v is untouched and u halves exactly.
                assert_eq!(
                    [quad.uv_min[0] * 2048.0, quad.uv_max[0] * 2048.0],
                    [old_min[0] * 1024.0, old_max[0] * 1024.0],
                    "{name} slot {slot}"
                );
                assert_eq!(
                    [quad.uv_min[1], quad.uv_max[1]],
                    [old_min[1], old_max[1]],
                    "{name} slot {slot}"
                );
            }
        }
    }

    #[test]
    fn every_added_character_has_its_own_visible_unclipped_glyph_in_every_face() {
        assert!(EXTENDED_GLYPHS.windows(2).all(|pair| pair[0] < pair[1]));
        let atlas = GlyphAtlas::new();
        let fonts = [
            IBM_PLEX_SANS_REGULAR,
            IBM_PLEX_SANS_MEDIUM,
            IBM_PLEX_SANS_SEMIBOLD,
            IBM_PLEX_MONO_REGULAR,
            IBM_PLEX_MONO_SEMIBOLD,
        ]
        .map(|bytes| Font::from_bytes(bytes, FontSettings::default()).expect("font must parse"));
        let drawable = (GLYPH_PIXELS - GLYPH_PADDING * 2) as usize;
        for (index, character) in EXTENDED_GLYPHS.into_iter().enumerate() {
            let slot = PAGE_GLYPHS + index as u32;
            assert_eq!(glyph_index(character), slot, "{character:?}");
            for (face, name, _) in FACES {
                let font = &fonts[face as usize];
                assert_ne!(
                    font.lookup_glyph_index(character),
                    0,
                    "{name} lacks {character:?}"
                );
                let source = font.metrics(character, RASTER_SIZE);
                assert!(
                    source.width <= drawable && source.height <= drawable,
                    "{name} clips {character:?}"
                );
                let metric = metric(&atlas, face, slot);
                assert_eq!(
                    (metric.atlas_x, metric.atlas_y),
                    (
                        (PAGE_COLUMNS + index as u32 % PAGE_COLUMNS) * GLYPH_PIXELS + GLYPH_PADDING,
                        (face as u32 * GLYPH_ROWS + index as u32 / PAGE_COLUMNS) * GLYPH_PIXELS
                            + GLYPH_PADDING
                    ),
                    "{name} {character:?}"
                );
                assert!(
                    (0..metric.height).any(|y| (0..metric.width).any(|x| {
                        atlas.pixels
                            [((metric.atlas_y + y) * atlas.width + metric.atlas_x + x) as usize]
                            > 0
                    })),
                    "{name} draws nothing for {character:?}"
                );
            }
        }
    }

    #[test]
    fn only_a_literal_question_mark_draws_the_question_mark_slot() {
        let question_mark = u32::from(b'?' - FIRST_GLYPH);
        for character in (0..=u32::from(char::MAX)).filter_map(char::from_u32) {
            assert_eq!(
                glyph_index(character) == question_mark,
                character == '?',
                "{character:?}"
            );
        }
    }

    #[test]
    fn characters_without_a_slot_draw_the_replacement_glyph_at_its_own_advance() {
        let atlas = GlyphAtlas::new();
        assert_eq!(slot_character(FALLBACK_GLYPH_INDEX), '\u{fffd}');
        for character in [
            '漢', '🙂', '\u{301}', '\u{200b}', 'Ω', '\u{0}', '\u{7f}', '¼',
        ] {
            assert!(!GlyphAtlas::covers(character), "{character:?}");
            assert_eq!(
                glyph_index(character),
                FALLBACK_GLYPH_INDEX,
                "{character:?}"
            );
        }
        for (face, name, family) in FACES {
            let quads = atlas.layout(
                "a漢b",
                Vec2::new(0.0, 0.0),
                f64::MAX,
                family,
                f64::from(RASTER_SIZE),
                TextAlign::Start,
            );
            let replacement = metric(&atlas, face, FALLBACK_GLYPH_INDEX);
            assert_eq!(
                quads[1].uv_min,
                [
                    replacement.atlas_x as f32 / atlas.width as f32,
                    replacement.atlas_y as f32 / atlas.height as f32
                ],
                "{name}"
            );
            let pen_advance = (quads[2].rect.x
                - f64::from(metric(&atlas, face, glyph_index('b')).xmin))
                - (quads[1].rect.x - f64::from(replacement.xmin));
            assert_eq!(pen_advance, f64::from(replacement.advance), "{name}");
            let sans = !matches!(face, FontFace::MonoRegular | FontFace::MonoSemibold);
            assert_eq!(
                replacement.advance / RASTER_SIZE,
                if sans { 1.0 } else { 0.6 },
                "{name}"
            );
        }
    }

    #[test]
    fn whitespace_aliases_draw_the_space_slot() {
        for character in SPACE_ALIASES {
            assert!(GlyphAtlas::covers(character), "{character:?}");
            assert_eq!(glyph_index(character), SPACE_GLYPH_INDEX, "{character:?}");
        }
    }

    #[test]
    fn bundled_atlas_contains_visible_pixels() {
        let atlas = GlyphAtlas::new();
        assert_eq!(atlas.width(), 2048);
        assert_eq!(atlas.height(), 1920);
        assert!(atlas.pixels().contains(&255));
    }

    #[test]
    fn layout_respects_width_and_alignment() {
        let atlas = GlyphAtlas::new();
        let glyphs = atlas.layout(
            "Architecture",
            Vec2::new(100.0, 40.0),
            30.0,
            "IBM Plex Sans",
            10.0,
            TextAlign::Center,
        );
        assert!(glyphs.len() >= 4);
        assert!(glyphs[0].rect.x < 100.0);
    }

    #[test]
    fn display_fitting_is_unicode_safe_and_matches_compiler_golden_cases() {
        assert_eq!(
            fit_text_content("Über façade compiler pipeline", 14),
            "Über façade…"
        );
        assert_eq!(fit_text_content("unbreakable", 6), "unbre…");
        assert_eq!(fit_text_content("architecture", 0), "");
        assert_eq!(fit_text_content("architecture", 1), "…");
        assert_eq!(fit_text_content("architecture", 2), "a…");
        assert_eq!(
            fit_text_content("packages/architecture/src/normalized.ts", 25),
            "packages/…/normalized.ts"
        );
        assert_eq!(
            fit_text_content("packages/architecture/src/normalized.ts", 20),
            "…/src/normalized.ts"
        );
        assert_eq!(
            fit_text_content("packages/architecture/src/normalized.ts", 8),
            "…ized.ts"
        );
        assert_eq!(
            fit_text_content("@fontsource/ibm-plex-sans", 16),
            "…/ibm-plex-sans"
        );
    }

    #[test]
    fn ellipsis_has_a_dedicated_visible_atlas_glyph() {
        let atlas = GlyphAtlas::new();
        let glyphs = atlas.layout(
            "A very long label",
            Vec2::new(0.0, 10.0),
            12.5,
            "IBM Plex Sans",
            10.0,
            TextAlign::Start,
        );
        assert_eq!(glyphs.len(), 1);
        let origin_x = 15 * GLYPH_PIXELS + GLYPH_PADDING;
        let origin_y = 5 * GLYPH_PIXELS + GLYPH_PADDING;
        assert_eq!(
            glyphs[0].uv_min,
            [
                origin_x as f32 / atlas.width as f32,
                origin_y as f32 / atlas.height as f32
            ]
        );
        let metric = atlas.metrics[ELLIPSIS_GLYPH_INDEX as usize];
        assert!((0..metric.height).any(|y| (0..metric.width).any(|x| {
            atlas.pixels[((metric.atlas_y + y) * atlas.width + metric.atlas_x + x) as usize] > 0
        })));
    }
}
