use atlas_gpu::GlyphAtlas;
use serde_json::Value;

const SCENE: &str = include_str!("../../../fixtures/renderer/demo-scene.json");
const TIMELINE: &str = include_str!("../../../fixtures/renderer/demo-timeline.json");

/// Every text primitive's content anywhere in a scene, patch or timeline document.
fn text_contents<'a>(value: &'a Value, found: &mut Vec<&'a str>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| text_contents(item, found)),
        Value::Object(fields) => {
            if fields.get("kind").and_then(Value::as_str) == Some("text") {
                if let Some(content) = fields.get("content").and_then(Value::as_str) {
                    found.push(content);
                }
            }
            fields.values().for_each(|item| text_contents(item, found));
        }
        _ => {}
    }
}

#[test]
fn every_character_of_the_golden_fixtures_has_a_glyph_in_the_atlas() {
    let documents = [SCENE, TIMELINE]
        .map(|json| serde_json::from_str::<Value>(json).expect("renderer fixture must parse"));
    let mut contents = Vec::new();
    for document in &documents {
        text_contents(document, &mut contents);
    }
    assert!(
        contents
            .iter()
            .any(|content| content.contains('·') && content.contains('–')),
        "golden code-card kickers must be covered by this check"
    );
    let uncovered: Vec<_> = contents
        .iter()
        .flat_map(|content| {
            content
                .chars()
                .filter(|character| !GlyphAtlas::covers(*character))
                .map(move |character| format!("U+{:04X} in {content:?}", character as u32))
        })
        .collect();
    assert!(uncovered.is_empty(), "{uncovered:#?}");
}
