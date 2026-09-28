// Final-text removal of Chinese hesitation fillers: 嗯 and 呃 anywhere, and 额
// only when it stands alone (it is also the 额 of 额度/额外/余额).
//
// Qwen writes a hesitation as the filler plus the pause punctuation around it:
// in 200 real dictations (2026-09-28) the shapes were "，呃，" (39), "。呃，"
// (15), a leading "呃，" (14) and a bare "这个呃网站" (21). So a filler is
// removed together with the adjacent pause marks and spaces, and that whole
// span collapses to the strongest mark it contained: "觉得，呃，我们" keeps one
// comma, "二十。呃，这样" keeps the full stop, a leading or trailing span keeps
// nothing but a sentence end. A comma that only followed the filler still
// survives ("第一呃，浏览器" → "第一，浏览器"): it may be a real clause break,
// and a spare comma is cheaper than a run-on sentence.
//
// A filler inside quotation marks is left alone: quoted speech is verbatim
// (他说：“嗯，好吧。”), and a quoted filler is usually being talked about
// ("“嗯”这种词"). So is a filler that is listed with other interjections
// ("嗯啊啊呀", "呃、嗯、啊"), named ("嗯这种词"), used as a word (呃逆, 嗯了一声)
// or reported as an answer (我说嗯). Keeping a filler only leaves the raw
// transcript as it was; deleting a meaningful one changes what was said.

/// Pause punctuation a filler span absorbs, ranked so the strongest survives.
fn pause_rank(c: char) -> Option<u8> {
  match c {
    '，' | ',' | '—' | '、' => Some(1),
    '；' | ';' | '：' | ':' => Some(2),
    '…' => Some(3),
    '。' | '？' | '！' | '.' | '?' | '!' => Some(4),
    _ => None,
  }
}

/// A sentence end may close text; commas, colons and dashes may not.
const MIN_TRAILING_RANK: u8 = 3;

fn is_pause_or_space(c: char) -> bool {
  c == ' ' || pause_rank(c).is_some()
}

fn opens(c: char) -> bool {
  matches!(c, '“' | '‘' | '「' | '『' | '（' | '(' | '【' | '[' | '《' | '〈' | '{')
}

fn closes(c: char) -> bool {
  matches!(c, '”' | '’' | '」' | '』' | '）' | ')' | '】' | ']' | '》' | '〉' | '}')
}

// Straight quotes open and close, so they only count when both sides agree.
fn is_straight_quote(c: char) -> bool {
  matches!(c, '"' | '\'')
}

fn closing_quote(open: char) -> Option<char> {
  match open {
    '“' => Some('”'),
    '‘' => Some('’'),
    '「' => Some('」'),
    '『' => Some('』'),
    '"' => Some('"'),
    _ => None,
  }
}

/// Marks the characters between each matched pair of quotation marks. An
/// unmatched mark quotes nothing: ’ doubles as an apostrophe, and ASR may drop
/// a closing quote. The straight apostrophe is never treated as a quote.
fn quoted_positions(chars: &[char]) -> Vec<bool> {
  let mut quoted = vec![false; chars.len()];
  let mut open: Vec<(usize, char)> = Vec::new();
  for (i, &c) in chars.iter().enumerate() {
    if let Some(depth) = open.iter().rposition(|&(_, closer)| closer == c) {
      let start = open[depth].0;
      quoted[start + 1..i].iter_mut().for_each(|q| *q = true);
      open.truncate(depth);
    } else if let Some(closer) = closing_quote(c) {
      open.push((i, closer));
    }
  }
  quoted
}

// Interjections that stay in the text. A filler touching one is being listed
// ("嗯啊啊呀这样子"), not hesitated with.
fn is_kept_interjection(c: char) -> bool {
  matches!(c, '啊' | '呀' | '哦' | '噢' | '喔' | '哎' | '唉' | '诶' | '欸' | '哈' | '嘿' | '哼')
}

// Same ranges as the frontend's chunk joiner: ideographs and full-width forms.
fn is_cjk(c: char) -> bool {
  matches!(c,
    '\u{3000}'..='\u{303f}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'
    | '\u{f900}'..='\u{faff}' | '\u{ff00}'..='\u{ffef}')
}

/// Text after a filler that names it instead of saying it: "嗯这种词", "呃之类的".
const MENTION_NEXT: &[&str] = &[
  "之类", "语气词", "这种词", "这类词", "这些词", "这个词", "这样的词", "等词",
  "这种语气词", "这类语气词", "这些语气词", "这个语气词", "这样的语气词", "等语气词",
];

/// 嗯 used as a verb: "他嗯了一声".
const NG_AS_VERB_NEXT: &[&str] = &["一声", "两声", "了一声", "了两声", "了几声", "了一下"];

/// 嗯 reported as someone's answer: "我说嗯", "他回嗯".
fn introduces_answer(c: char) -> bool {
  matches!(c, '说' | '答' | '应' | '回')
}

fn is_filler_at(chars: &[char], i: usize) -> bool {
  match chars[i] {
    '嗯' | '呃' => true,
    '额' => {
      let bounded = |c: Option<&char>| c.map_or(true, |&c| is_pause_or_space(c) || matches!(c, '嗯' | '呃'));
      bounded(i.checked_sub(1).and_then(|j| chars.get(j))) && bounded(chars.get(i + 1))
    }
    _ => false,
  }
}

/// Remove hesitation fillers from a complete transcription. Text without a
/// removable filler is returned unchanged; text that was nothing but fillers
/// becomes empty, which the frontend already renders as the no-speech state.
pub fn remove_fillers(text: &str) -> String {
  let chars: Vec<char> = text.chars().collect();
  let is_filler: Vec<bool> = (0..chars.len()).map(|i| is_filler_at(&chars, i)).collect();
  if !is_filler.contains(&true) {
    return text.to_string();
  }
  let quoted = quoted_positions(&chars);
  let in_span = |i: usize| is_filler[i] || is_pause_or_space(chars[i]);
  let mut out = String::with_capacity(text.len());
  let mut i = 0;
  while i < chars.len() {
    if !in_span(i) {
      out.push(chars[i]);
      i += 1;
      continue;
    }
    let start = i;
    while i < chars.len() && in_span(i) {
      i += 1;
    }
    let span = Span { chars: &chars, is_filler: &is_filler, start, end: i };
    if !is_filler[start..i].contains(&true) || quoted[start] || span.is_mention() {
      out.extend(&chars[start..i]);
    } else {
      out.push_str(&span.collapse());
    }
  }
  if out.trim().is_empty() {
    return String::new();
  }
  out
}

/// A maximal run of fillers, pause marks and spaces, `chars[start..end]`.
struct Span<'a> {
  chars: &'a [char],
  is_filler: &'a [bool],
  start: usize,
  end: usize,
}

impl Span<'_> {
  fn left(&self) -> Option<char> {
    self.start.checked_sub(1).map(|j| self.chars[j])
  }

  fn right(&self) -> Option<char> {
    self.chars.get(self.end).copied()
  }

  /// The filler touching the character before the span, if any.
  fn first_filler(&self) -> Option<char> {
    self.is_filler[self.start].then(|| self.chars[self.start])
  }

  /// The filler touching the character after the span, if any.
  fn last_filler(&self) -> Option<char> {
    self.is_filler[self.end - 1].then(|| self.chars[self.end - 1])
  }

  fn is_mention(&self) -> bool {
    let (left, right) = (self.left(), self.right());
    let quoted = left.is_some_and(|c| opens(c) || is_straight_quote(c))
      && right.is_some_and(|c| closes(c) || is_straight_quote(c));
    if quoted || self.chars[self.start..self.end].contains(&'、') {
      return true;
    }
    if let Some(filler) = self.first_filler() {
      let left = left.unwrap_or(' ');
      if is_kept_interjection(left) || (filler == '嗯' && introduces_answer(left)) {
        return true;
      }
    }
    if let Some(filler) = self.last_filler() {
      if right.is_some_and(is_kept_interjection) {
        return true;
      }
      let rest: String = self.chars[self.end..].iter().take(6).collect();
      if MENTION_NEXT.iter().any(|next| rest.starts_with(next))
        || (filler == '呃' && rest.starts_with('逆'))
        || (filler == '嗯' && NG_AS_VERB_NEXT.iter().any(|next| rest.starts_with(next)))
      {
        return true;
      }
    }
    false
  }

  /// The strongest contiguous group of pause marks, the earliest on a tie.
  fn strongest_pause(&self) -> Option<(u8, &[char])> {
    let mut best: Option<(u8, &[char])> = None;
    let mut k = self.start;
    while k < self.end {
      if self.is_filler[k] || self.chars[k] == ' ' {
        k += 1;
        continue;
      }
      let group_start = k;
      let mut rank = 0;
      while k < self.end && !self.is_filler[k] && self.chars[k] != ' ' {
        rank = rank.max(pause_rank(self.chars[k]).unwrap_or(0));
        k += 1;
      }
      if best.map_or(true, |(best_rank, _)| rank > best_rank) {
        best = Some((rank, &self.chars[group_start..k]));
      }
    }
    best
  }

  fn collapse(&self) -> String {
    let had_space = self.chars[self.start..self.end].contains(&' ');
    let pause = self.strongest_pause();
    // Line breaks, tabs and brackets bound a clause the same way the text's
    // ends do, so no punctuation may be left dangling against them.
    let (left, right) = match (self.left(), self.right()) {
      (Some(left), Some(right)) if !opens(left) && !left.is_whitespace()
        && !closes(right) && !right.is_whitespace() => (left, right),
      (Some(left), _) if !opens(left) && !left.is_whitespace() => {
        return match pause {
          Some((rank, marks)) if rank >= MIN_TRAILING_RANK => marks.iter().collect(),
          _ => String::new(),
        };
      }
      _ => return String::new(),
    };
    match pause {
      Some((_, marks)) => {
        let mut kept: String = marks.iter().collect();
        if had_space && kept.is_ascii() {
          kept.push(' ');
        }
        kept
      }
      None => {
        let words_touch = left.is_ascii_alphanumeric() && right.is_ascii_alphanumeric();
        if words_touch || (had_space && !(is_cjk(left) && is_cjk(right))) {
          " ".to_string()
        } else {
          String::new()
        }
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn check(cases: &[(&str, &str)]) {
    for &(input, expected) in cases {
      assert_eq!(remove_fillers(input), expected, "{input:?}");
      assert_eq!(remove_fillers(expected), expected, "not idempotent: {input:?}");
    }
  }

  fn unchanged(inputs: &[&str]) {
    for &input in inputs {
      assert_eq!(remove_fillers(input), input, "{input:?}");
    }
  }

  #[test]
  fn removes_fillers_in_the_shapes_qwen_writes() {
    // Every shape seen in real History, 2026-09-28.
    check(&[
      ("我觉得，呃，我们是不是可以", "我觉得，我们是不是可以"),
      ("呃，我已经成功", "我已经成功"),
      ("一个月二十。呃，这样的话", "一个月二十。这样的话"),
      ("变高，是吧？呃，你觉得", "变高，是吧？你觉得"),
      ("能够知道这个呃网站有哪些人", "能够知道这个网站有哪些人"),
      ("入北约，那北嗯俄罗斯生气", "入北约，那北俄罗斯生气"),
      ("剩下的token不多了，嗯。", "剩下的token不多了。"),
      ("文案是打算怎么做？就是，呃。", "文案是打算怎么做？就是。"),
      ("嗯，这张图看着", "这张图看着"),
      ("Knight”呃这个字体稍微变小", "Knight”这个字体稍微变小"),
    ]);
  }

  #[test]
  fn a_span_keeps_only_its_strongest_mark() {
    check(&[
      ("觉得，呃，嗯，就是", "觉得，就是"),
      ("呃呃，嗯嗯，我们", "我们"),
      ("你觉得呢，嗯？", "你觉得呢？"),
      ("他说：呃，好吧", "他说：好吧"),
      ("我觉得……呃，这个", "我觉得……这个"),
      ("我觉得，呃……", "我觉得……"),
      ("对吧？！呃，你", "对吧？！你"),
      ("觉得——呃，然后", "觉得——然后"),
      // A chunk seam can put two sentence ends into one span.
      ("第一段。嗯。呃，第二段", "第一段。第二段"),
    ]);
  }

  #[test]
  fn a_comma_that_only_follows_the_filler_is_kept() {
    check(&[
      ("第一呃，浏览器如果是繁体", "第一，浏览器如果是繁体"),
      ("耗的量非常有限，而嗯，你随便吃", "耗的量非常有限，而，你随便吃"),
    ]);
  }

  #[test]
  fn text_that_is_only_fillers_becomes_empty() {
    for input in ["嗯。", "嗯", "呃，嗯。", "嗯嗯", " 呃 ", "额。"] {
      assert_eq!(remove_fillers(input), "", "{input:?}");
    }
  }

  #[test]
  fn nothing_dangles_at_text_bracket_or_line_edges() {
    check(&[
      ("好的，呃", "好的"),
      ("（嗯，其实是这样）", "（其实是这样）"),
      ("（好吧，嗯。）", "（好吧。）"),
      ("（其实嗯）", "（其实）"),
      ("第一行\n呃，第二行", "第一行\n第二行"),
      ("第一行，嗯\n第二行", "第一行\n第二行"),
    ]);
  }

  #[test]
  fn spacing_follows_the_surrounding_script() {
    check(&[
      ("就是 Block 呃 Chanl 这个按钮", "就是 Block Chanl 这个按钮"),
      ("我觉得这个 Style 嗯不太对劲, 对吧?", "我觉得这个 Style 不太对劲, 对吧?"),
      ("不用自己去看 呃 Vercel", "不用自己去看 Vercel"),
      ("API呃Key", "API Key"),
      ("Vercel, 呃, the site", "Vercel, the site"),
      ("对吧? 呃, 这个", "对吧? 这个"),
      ("去,呃,然后", "去,然后"),
      ("这个 呃 网站", "这个网站"),
    ]);
  }

  #[test]
  fn quoted_speech_keeps_its_fillers() {
    unchanged(&[
      "他说：“嗯，好吧。”",
      "他说：“呃，我不知道，嗯。”",
      "“好吧，呃”",
      "她回了一句「嗯，行」",
      "He said \"嗯, OK\" and left",
      "他说：“她问我‘嗯，去不去’，我没回。”",
    ]);
    check(&[
      ("呃，他说：“嗯，好吧。”", "他说：“嗯，好吧。”"),
      ("他说“好吧”，呃，然后走了", "他说“好吧”，然后走了"),
      ("“第一段”呃“第二段”", "“第一段”“第二段”"),
      // An apostrophe or an unmatched mark quotes nothing.
      ("it’s 呃 fine", "it’s fine"),
      ("don't 呃 go", "don't go"),
    ]);
  }

  #[test]
  fn an_unclosed_quote_protects_nothing() {
    // ASR can drop the closing mark; without it nothing counts as quoted.
    check(&[("他说：“嗯，好吧", "他说：“好吧")]);
  }

  #[test]
  fn standalone_e_is_a_filler_but_words_with_e_are_not() {
    check(&[
      ("额，我觉得", "我觉得"),
      ("好的，额，然后", "好的，然后"),
      ("嗯额，然后", "然后"),
    ]);
    unchanged(&["免费版额度是一个月", "你还有额外的实力", "余额，还够", "金额。"]);
  }

  #[test]
  fn fillers_being_talked_about_are_kept() {
    unchanged(&[
      "那尤其是“嗯”这种词，我觉得",
      "把一些很明显的“呃”这种词给它过滤掉",
      "像\"嗯\"和'呃'",
      "「嗯」",
      "“嗯。”",
      "我发现我说话的时候会有各种语气词，嗯啊啊呀这样子。",
      "像呃、嗯、啊这些",
      "嗯这种词",
      "呃之类的语气词",
      "打嗝在医学上叫呃逆",
      "他嗯了一声就走了",
      "我问他去不去，他说嗯。",
      "嗯哼",
    ]);
  }

  #[test]
  fn text_without_fillers_is_untouched() {
    unchanged(&[
      "", " ", " A P I  ", "今天天气不错，我们去公园散步吧。How about you?",
      "啊，好的呀", "A\tP\nI", "10:30, e.g. this",
    ]);
  }
}
