//! Scanned pages, read on the device. The renderer draws a PDF
//! page that has no text (a scan or a photo) into a picture and hands the
//! picture here; Windows.Media.Ocr reads it, on the device. The PC's
//! recognizer languages are used exactly as they are installed — the app never
//! changes the language settings; a missing language comes back as a message
//! that names the pack to add, for the person to install themselves.
//!
//! The engine call sits behind a small trait, so the unit tests fake the
//! recognition and everything around it is still tested.

use serde::Serialize;
use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapDecoder, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

/// One page's recognition: the words, and the language they were read in.
#[derive(Serialize, Debug)]
pub struct OcrPage {
    pub text: String,
    pub language: String,
}

/// The recognition call itself, decoupled from Windows so tests can fake it: the picture in, the recognized words out.
/// (The async-fn-in-trait lint is silenced: the trait is crate-local, used only in this module and its tests.)
#[allow(async_fn_in_trait)]
pub trait Recognize<I: ?Sized> {
    async fn lines(&self, image: &I) -> Result<String, String>;
}

/// One page through any engine: the recognized words, cleaned of carriage returns and edge whitespace, with the language named.
pub async fn read_page<I: ?Sized, R: Recognize<I>>(engine: &R, image: &I, language: &str) -> Result<OcrPage, String> {
    let raw = engine.lines(image).await?;
    let text = raw.replace("\r\n", "\n").replace('\r', "\n").trim().to_string();
    Ok(OcrPage { text, language: language.to_string() })
}

/// The real engine: Windows.Media.Ocr, on the device.
pub struct WindowsEngine(pub OcrEngine);

impl Recognize<SoftwareBitmap> for WindowsEngine {
    async fn lines(&self, bitmap: &SoftwareBitmap) -> Result<String, String> {
        let win = |e: windows::core::Error| format!("the recognizer could not run: {e}");
        let result = self.0.RecognizeAsync(bitmap).map_err(win)?.await.map_err(win)?;
        result.Text().map(|t| t.to_string()).map_err(win)
    }
}

/// The recognizer languages this PC has installed, as BCP-47 tags ("en-US", "ar-SA").
pub fn installed_tags() -> Vec<String> {
    match OcrEngine::AvailableRecognizerLanguages() {
        Ok(list) => list
            .into_iter()
            .filter_map(|l| l.LanguageTag().ok().map(|t| t.to_string()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// The installed tag for a hint: "ar" matches "ar-SA" by prefix, "en-US" exactly; an empty hint names nothing.
pub fn best_tag(available: &[String], hint: &str) -> Option<String> {
    let h = hint.trim().to_lowercase();
    if h.is_empty() {
        return None;
    }
    available
        .iter()
        .find(|t| t.to_lowercase() == h)
        .cloned()
        .or_else(|| available.iter().find(|t| t.to_lowercase().starts_with(&format!("{h}-"))).cloned())
}

/// What the person reads when the document's language has no recognizer installed: which pack to add, and where — never the app changing the settings itself.
pub fn missing_language_message(hint: &str) -> String {
    let name = match hint.trim().to_lowercase().as_str() {
        "ar" | "ar-*" => "Arabic",
        "en" | "en-*" => "English",
        _ => "that language's",
    };
    format!(
        "{name} text recognition is not installed on this PC. Add it in Windows: Settings > Time & language > Language & region > Add a language, and let the language features finish installing. The app does not change these settings itself."
    )
}

/// The engine for a hint's language ("ar", "en"); an empty hint means "the person's own languages" — the engine Windows itself would pick for them.
pub fn engine_for(hint: &str) -> Result<(OcrEngine, String), String> {
    if hint.trim().is_empty() {
        return match OcrEngine::TryCreateFromUserProfileLanguages() {
            Ok(e) => Ok((e, "the PC's own languages".into())),
            Err(_) => Err(missing_language_message("")),
        };
    }
    let tags = installed_tags();
    match best_tag(&tags, hint) {
        Some(tag) => {
            let made = Language::CreateLanguage(&HSTRING::from(tag.as_str()))
                .map_err(|e| format!("the recognizer language could not be made: {e}"))
                .and_then(|l| OcrEngine::TryCreateFromLanguage(&l).map_err(|e| format!("the recognizer could not be made: {e}")));
            match made {
                Ok(engine) => Ok((engine, tag)),
                // the language is installed but carries no recognizer: the same pack message stands
                Err(_) => Err(missing_language_message(hint)),
            }
        }
        None => Err(missing_language_message(hint)),
    }
}

/// One page, end to end: the PNG bytes the renderer drew, decoded, recognized on the device.
pub async fn recognize_png(png: &[u8], hint: &str) -> Result<OcrPage, String> {
    let bitmap = decode_png(png).await?;
    let (engine, tag) = engine_for(hint)?;
    read_page(&WindowsEngine(engine), &bitmap, &tag).await
}

/// A PNG's bytes into the bitmap the recognizer reads.
async fn decode_png(png: &[u8]) -> Result<SoftwareBitmap, String> {
    let win = |e: windows::core::Error| format!("the page picture could not be read: {e}");
    let stream = InMemoryRandomAccessStream::new().map_err(win)?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(win)?;
    writer.WriteBytes(png).map_err(win)?;
    writer.StoreAsync().map_err(win)?.await.map_err(win)?;
    writer.FlushAsync().map_err(win)?.await.map_err(win)?;
    writer.DetachStream().map_err(win)?;
    stream.Seek(0).map_err(win)?;
    let decoder = BitmapDecoder::CreateAsync(&stream).map_err(win)?.await.map_err(win)?;
    decoder.GetSoftwareBitmapAsync().map_err(win)?.await.map_err(win)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A faked recognition: one fixed reply, the call count remembered.
    struct FakeEngine {
        reply: Result<String, String>,
        calls: std::sync::atomic::AtomicUsize,
    }
    impl Recognize<u8> for FakeEngine {
        async fn lines(&self, _image: &u8) -> Result<String, String> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.reply.clone()
        }
    }

    #[tokio::test]
    async fn read_page_returns_the_words_trimmed_and_names_the_language() {
        let engine = FakeEngine { reply: Ok("first line\r\nsecond line\r\n".into()), calls: std::sync::atomic::AtomicUsize::new(0) };
        let page = read_page(&engine, &7u8, "ar-SA").await.expect("the fake read works");
        assert_eq!(page.text, "first line\nsecond line");
        assert_eq!(page.language, "ar-SA");
        assert_eq!(engine.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn read_page_passes_a_failed_recognition_through() {
        let engine = FakeEngine { reply: Err("no Arabic recognizer".into()), calls: std::sync::atomic::AtomicUsize::new(0) };
        let e = read_page(&engine, &7u8, "ar").await.expect_err("the failure rides");
        assert_eq!(e, "no Arabic recognizer");
    }

    #[test]
    fn best_tag_matches_the_hint_by_prefix_and_exactly() {
        let tags = vec!["en-US".to_string(), "ar-SA".to_string(), "ar-EG".to_string()];
        assert_eq!(best_tag(&tags, "ar"), Some("ar-SA".to_string()));
        assert_eq!(best_tag(&tags, "en"), Some("en-US".to_string()));
        assert_eq!(best_tag(&tags, "en-US"), Some("en-US".to_string()));
        assert_eq!(best_tag(&tags, "fr"), None);
        assert_eq!(best_tag(&tags, ""), None); // empty: nothing is named
    }

    #[test]
    fn the_missing_language_message_names_the_pack_and_where_to_add_it() {
        let ar = missing_language_message("ar");
        assert!(ar.contains("Arabic"));
        assert!(ar.contains("Add a language"));
        assert!(ar.contains("does not change"));
        let en = missing_language_message("en");
        assert!(en.contains("English"));
        let other = missing_language_message("");
        assert!(other.contains("recognition is not installed"));
    }
}
