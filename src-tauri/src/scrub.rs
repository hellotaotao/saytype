// Transcription post-filter: strip known Whisper hallucination boilerplate.
//
// whisper-large-v3 (zh) fills silence gaps — thinking pauses mid-dictation and
// the tail between the last word and hotkey release — with YouTube-outro
// boilerplate from its training data ("明镜与点点" is a channel whose subtitle
// outros saturate the zh corpus). Diagnosed 2026-07-04 from real history: six
// correct long transcriptions each carried the outro appended at the tail or
// mid-pause (see TODO.md #10). The VAD gate can't help: it only decides
// send/don't-send for the whole clip, and these clips genuinely contain speech.
//
// The blocklist is deliberately evidence-driven and high-precision: every
// pattern anchors on tokens no real dictation plausibly produces IN THAT SHAPE
// (the full like-subscribe chain plus the channel name; the Amara credit). A
// bare "点赞,订阅,转发" without the channel anchor is NOT scrubbed — the user
// really could dictate that while talking about social media.

use std::sync::OnceLock;

use regex::Regex;

use crate::commands::SEED_ZH;

fn boilerplate_patterns() -> &'static Vec<Regex> {
  static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
  PATTERNS.get_or_init(|| {
    let sep = r"[\s、,,]*";
    vec![
      // The 明镜与点点 outro family. Requires the full 点赞/订阅/转发 chain AND
      // the channel name — either alone is not distinctive enough. Consumes an
      // immediately-following "我们继续" (a SEED_ZH fragment the decoder chains
      // onto the outro — observed 2026-07-04) and any trailing punctuation.
      Regex::new(&format!(
        r"请{sep}(?:不{sep}吝)?{sep}点赞{sep}订阅{sep}转发{sep}(?:打赏)?{sep}(?:支持)?{sep}明镜与点点栏目?(?:{sep}我们继续)?[\s。.!!,,]*"
      ))
      .expect("outro regex"),
      // Amara subtitle credits — another canonical zh Whisper hallucination.
      Regex::new(r"(?i)本?字幕由\s*Amara\.?org\s*社[区群]提供[\s。.!!,,]*").expect("amara regex"),
      Regex::new(r"(?i)由\s*Amara\.?org\s*社[区群]提供的字幕[\s。.!!,,]*").expect("amara-of regex"),
    ]
  })
}

/// Strip known hallucination boilerplate from a transcription. Returns the
/// cleaned text; an output that was NOTHING BUT boilerplate becomes an empty
/// string, which the frontend already renders as the no-speech state.
pub fn scrub_transcription(text: &str) -> String {
  if text.trim().is_empty() {
    return String::new();
  }
  if is_seed_echo(text) {
    return String::new();
  }
  let mut out = text.to_string();
  let mut removed_any = false;
  for pattern in boilerplate_patterns() {
    let replaced = pattern.replace_all(&out, "");
    if replaced != out {
      removed_any = true;
      out = replaced.into_owned();
    }
  }
  if !removed_any {
    return out;
  }
  collapse_whitespace_runs(&out).trim().to_string()
}

// Prompt-leak detector: on degenerate audio Whisper sometimes emits the prompt
// itself as the transcription — observed as one SEED_ZH fragment repeated 15x
// ("欢迎使用听写工具。"), and guarded here as "the ENTIRE output is the seed, or
// one seed fragment repeated at least twice". A fragment said ONCE survives:
// that is plausibly the user reading the seed aloud while testing.
fn is_seed_echo(text: &str) -> bool {
  let t = without_whitespace(text);
  if t.is_empty() {
    return false;
  }
  if t == without_whitespace(SEED_ZH) {
    return true;
  }
  seed_fragments().iter().any(|fragment| {
    !fragment.is_empty()
      && t.len() >= fragment.len() * 2
      && t.len() % fragment.len() == 0
      && t == fragment.repeat(t.len() / fragment.len())
  })
}

// SEED_ZH split at every punctuation mark (terminator kept), whitespace
// removed — the leak repeats clause-sized fragments, not full sentences.
fn seed_fragments() -> &'static Vec<String> {
  static FRAGMENTS: OnceLock<Vec<String>> = OnceLock::new();
  FRAGMENTS.get_or_init(|| {
    let mut fragments = Vec::new();
    let mut current = String::new();
    for c in without_whitespace(SEED_ZH).chars() {
      current.push(c);
      if matches!(c, '。' | '？' | '！' | '，' | ',' | '.' | '?' | '!') {
        fragments.push(std::mem::take(&mut current));
      }
    }
    if !current.is_empty() {
      fragments.push(current);
    }
    fragments
  })
}

fn without_whitespace(text: &str) -> String {
  text.chars().filter(|c| !c.is_whitespace()).collect()
}

// Mid-text removals can leave a doubled space at the seam; collapse runs.
fn collapse_whitespace_runs(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  let mut in_run = false;
  for c in text.chars() {
    if c.is_whitespace() {
      if !in_run {
        out.push(' ');
        in_run = true;
      }
    } else {
      out.push(c);
      in_run = false;
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  // ---- the 明镜与点点 outro family (all six real 2026-07-04 history tails) ----

  #[test]
  fn strips_space_separated_outro_at_tail() {
    // history id 1783142073336
    let input = "是因为澳大利亚的黑产手机不需要改就能用。 请不吝点赞 订阅 转发 打赏支持明镜与点点栏目";
    assert_eq!(scrub_transcription(input), "是因为澳大利亚的黑产手机不需要改就能用。");
  }

  #[test]
  fn strips_comma_separated_outro_with_trailing_period() {
    // history id 1783141718711
    let input = "这种情况难道没有人反应,没有人造反的吗?请点赞,订阅,转发,打赏支持明镜与点点栏目。";
    assert_eq!(
      scrub_transcription(input),
      "这种情况难道没有人反应,没有人造反的吗?"
    );
  }

  #[test]
  fn strips_outro_mid_text_keeping_both_sides() {
    // history id 1783142158398 — hallucination in the MIDDLE, real speech resumes
    let input = "必须要经过一整套产业链给你开卡槽,换卡,用换卡贴。请不吝点赞 订阅 转发 打赏支持明镜与点点栏目 只不过就是他们卖掉换钱的方式不是把它卖到深圳去";
    assert_eq!(
      scrub_transcription(input),
      "必须要经过一整套产业链给你开卡槽,换卡,用换卡贴。只不过就是他们卖掉换钱的方式不是把它卖到深圳去"
    );
  }

  #[test]
  fn strips_outro_with_seed_echo_women_jixu() {
    // history id 1783141648523 — outro immediately chained into the SEED_ZH
    // fragment "我们继续!"
    let input = "其实绝大多数是不是只是正常的中产阶级,他们个人信息被盗,请不吝点赞 订阅 转发 打赏支持明镜与点点栏目我们继续!";
    assert_eq!(
      scrub_transcription(input),
      "其实绝大多数是不是只是正常的中产阶级,他们个人信息被盗,"
    );
  }

  #[test]
  fn keeps_genuine_mention_of_the_channel_name() {
    // history id 1783144144046 — the user DICTATING ABOUT this very bug; the
    // channel name appears without the like/subscribe chain and must survive.
    let input = "而且在中文的情况下,它一般是会说什么欢迎收听什么明镜与点点栏目什么等等这些东西。";
    assert_eq!(scrub_transcription(input), input);
  }

  #[test]
  fn keeps_bare_like_subscribe_chain_without_channel_anchor() {
    // Plausible real dictation about social media — no channel name, keep it.
    let input = "现在的视频结尾都会说请点赞,订阅,转发,这已经成了固定套路。";
    assert_eq!(scrub_transcription(input), input);
  }

  // ---- Amara subtitle credits ----

  #[test]
  fn strips_amara_credit_variants() {
    assert_eq!(scrub_transcription("今天先到这里。字幕由Amara.org社区提供"), "今天先到这里。");
    assert_eq!(scrub_transcription("由 Amara.org 社区提供的字幕"), "");
  }

  // ---- prompt-seed echo (degenerate-audio leak, observed 2026-07-03 sweep) ----

  #[test]
  fn whole_output_of_repeated_seed_sentence_becomes_empty() {
    // whisper-1 emitted one SEED_ZH sentence 15x as its entire output.
    let input = "欢迎使用听写工具。".repeat(15);
    assert_eq!(scrub_transcription(&input), "");
  }

  #[test]
  fn whole_output_equal_to_full_seed_becomes_empty() {
    assert_eq!(scrub_transcription(SEED_ZH), "");
  }

  #[test]
  fn single_seed_sentence_survives() {
    // Said ONCE it is plausibly the user testing the app by reading the seed
    // aloud — only the repetition (>=2x) is the leak signature.
    let input = "欢迎使用听写工具。";
    assert_eq!(scrub_transcription(input), input);
  }

  #[test]
  fn seed_sentence_inside_real_text_survives() {
    let input = "我说一句欢迎使用听写工具。然后接着说别的。";
    assert_eq!(scrub_transcription(input), input);
  }

  // ---- general hygiene ----

  #[test]
  fn clean_text_passes_through_unchanged() {
    let input = "今天天气不错,我们去公园散步吧。How about you?";
    assert_eq!(scrub_transcription(input), input);
  }

  #[test]
  fn empty_input_stays_empty() {
    assert_eq!(scrub_transcription(""), "");
  }
}
