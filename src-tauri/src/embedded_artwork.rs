//! Read embedded cover art from MPEG-4 files (Lofty). Stripping uses AtomicParsley in `tagging`.

use std::path::Path;

use lofty::file::TaggedFileExt;
use lofty::picture::{Picture, PictureType};
use lofty::read_from_path;
use lofty::tag::Tag;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedArtworkProbe {
    pub present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

fn pick_best_picture<'a>(tags: &'a [Tag]) -> Option<&'a Picture> {
    let mut best: Option<(&'a Picture, u8)> = None;
    for tag in tags {
        for pic in tag.pictures() {
            if pic.data().is_empty() {
                continue;
            }
            let prio = match pic.pic_type() {
                PictureType::CoverFront => 0u8,
                PictureType::CoverBack => 2u8,
                _ => 1u8,
            };
            let replace = match &best {
                None => true,
                Some((_, p)) => prio < *p,
            };
            if replace {
                best = Some((pic, prio));
            }
        }
    }
    best.map(|(p, _)| p)
}

/// Returns the first suitable embedded image (prefers front cover).
pub fn probe(path: &Path) -> EmbeddedArtworkProbe {
    let tagged = match read_from_path(path) {
        Ok(t) => t,
        Err(_) => {
            return EmbeddedArtworkProbe {
                present: false,
                data_base64: None,
                mime_type: None,
            };
        }
    };
    let Some(pic) = pick_best_picture(tagged.tags()) else {
        return EmbeddedArtworkProbe {
            present: false,
            data_base64: None,
            mime_type: None,
        };
    };
    let data = pic.data();
    let mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "image/jpeg".to_string());
    EmbeddedArtworkProbe {
        present: true,
        data_base64: Some(base64_encode(data)),
        mime_type: Some(mime),
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    B64.encode(bytes)
}
