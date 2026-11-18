
// shannon-anchor — tokenizer: the shared text-cutting logic.
//
// Latin splits on whitespace/punctuation. CJK has NO spaces, so a CJK run
// is cut into character bigrams — without that, a whole Chinese sentence
// is ONE token and every similarity score is zero. That was a real bug
// (the choice matcher silently failed on all Chinese input until a test
// caught it), which is why this lives in one shared, tested place instead
// of being copy-pasted into each module.
//
//   tokenize(s)     -> Set of unique tokens   (overlap / matching)
//   tokenizeList(s) -> array WITH repeats     (term frequency / BM25)

const RUN_RE = /[^a-z0-9\u4e00-\u9fa5]+/;

// Function words carry no topic. They matter more than they look: BM25 treats
// "the" in a title and "the" in a question as a real match, so a manual of
// English entries makes every question look related to the entry whose title
// happens to start with "The". Measured case: "what is the weather in Tokyo"
// scored 0.26 against a manual entry titled "the manual index is generated".
//
// CJK has its own equivalents (的/了/是/在...). Bigrams make these harder to
// filter cleanly, so only the unambiguous single-char function words are
// listed, and the CJK filter runs on the raw run before bigram cutting.
const STOP_LATIN = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this",
  "these", "those", "is", "are", "was", "were", "be", "been", "being",
  "am", "do", "does", "did", "have", "has", "had", "will", "would", "can",
  "could", "should", "may", "might", "must", "shall", "to", "of", "in", "on",
  "at", "by", "for", "with", "from", "as", "into", "about", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they", "them",
  "their", "there", "here", "what", "which", "who", "whom", "when", "where",
  "why", "how", "all", "any", "some", "no", "not", "so", "up", "out", "off",
  "over", "under", "again", "just", "only", "very", "too", "also", "s", "t"
]);

const STOP_CJK = new Set(["的", "了", "是", "在", "和", "与", "就", "都", "也", "很", "吗", "呢", "吧", "啊", "我", "你", "他", "她", "它"]);

// Time and date words. These are NOT topic, and they are the single biggest
// false-positive source in a manual that records when things happened.
//
// Measured 2026-10-19: every entry that says "今天" (and this manual has a
// lot of them — "今天犯了三次", "2026-10-19 实测") matched the query
// "今天天气怎么样" with 6/6 token overlap. The query carried no topic at
// all, yet #128 scored 0.605 and crossed the calibrated floor. Rerunning
// the probe after fixing wording alone did NOT help: the words are simply
// everywhere, because recording a date is what a memory manual does.
//
// This is the CJK equivalent of the English stop list, and it has to run
// BEFORE bigram cutting: "今天天气" cut into bigrams yields 今天/天天/天气/
// 气怎/怎么/么样, and 今天/天天/怎么 are exactly what makes a dateless query
// look like a dated entry.
//
// Same defect, second class, measured 2026-10-30: INTERROGATIVES. "怎么/什么/
// 哪儿" are the question, not its topic, and a manual that records incidents
// is full of "怎么办/怎么查". Every unrelated probe query ("今天天气怎么样",
// "晚饭吃什么") returned five entries on those bigrams alone, at absolute
// scores 0.49-0.53 — close enough to real hits (0.68-0.71) that the reader
// could not tell nearest neighbours from an answer.
const STOP_TIME_CJK = new Set([
  "今天", "天天", "昨天", "昨日", "前天", "明天", "明日", "后天",
  "今年", "去年", "明年", "上年", "下半年", "上半年",
  "现在", "目前", "当前", "此刻", "刚才", "刚刚", "已经", "曾经",
  "早上", "上午", "中午", "下午", "傍晚", "晚上", "夜里", "深夜", "凌晨",
  "时候", "时间", "日期", "当时", "那时", "后来", "之后", "以前", "之前",
  "最近", "近来", "目前", "暂时", "暂时", "当时", "当天", "当日",
  "一会儿", "一下", "这次", "上次", "下次", "这次", "每回", "每次"
]);

const STOP_QUESTION_CJK = new Set([
  "怎么办", "怎么", "怎样", "怎么样", "如何", "为什么", "为何",
  "什么", "哪儿", "哪里", "哪个", "哪些", "多少",
  "是否", "是不是", "能不能", "要不要", "有没有", "可不可以",
  "行不行", "好不好", "对不对", "咋", "咋办"
]);

// Scan the longest phrase that is actually listed. A fixed 3 missed
// "可不可以" and would let longer phrases through as ordinary bigrams.
const STOP_MAX = Math.max(
  ...[...STOP_TIME_CJK, ...STOP_QUESTION_CJK].map((s) => s.length)
);

// Split a CJK run at stop words before it is cut into bigrams.
// It must SPLIT, not delete in place: deleting mid-run glues the neighbours
// into a fake bigram ("守卫" + 怎么 + "用" -> 卫用), which then matches text
// nobody wrote. Longest-match-first so "明天早上" loses 明天 before 早上 and
// "怎么样" is not read as 怎么 + 样.
function splitAtCjkStops(run) {
  const segments = [];
  let cur = "";
  let i = 0;
  while (i < run.length) {
    let hit = null;
    for (let len = STOP_MAX; len >= 2; len--) {
      const seg = run.slice(i, i + len);
      if (seg.length === len && (STOP_TIME_CJK.has(seg) || STOP_QUESTION_CJK.has(seg))) { hit = seg; break; }
    }
    if (hit) {
      if (cur) segments.push(cur);
      cur = "";
      i += hit.length;
      continue;
    }
    cur += run[i];
    i += 1;
  }
  if (cur) segments.push(cur);
  return segments;
}

const SCRIPT_RUN_RE = /[a-z0-9]+|[\u4e00-\u9fa5]+/g;

function tokens(s) {
  const str = String(s).toLowerCase();
  const out = [];
  for (const w of str.split(RUN_RE)) {
    if (!w) continue;
    if (/^[a-z0-9]+$/.test(w)) {
      if (w.length >= 2 && !STOP_LATIN.has(w)) out.push(w);
      continue;
    }
    // A Latin word typed against Chinese has no separator ("tts是什么").
    // Bigramming across that boundary invented tt/ts/s是, and 是 is a stop
    // word, so only 2-character fragments shaped like identifiers survived —
    // enough for "tts是什么" to match router.ts at 0.657. Cut at the script
    // change; the Latin chunk is a whole word, the CJK chunk goes to bigrams.
    for (const chunk of w.match(SCRIPT_RUN_RE) || []) {
      if (/^[a-z0-9]+$/.test(chunk)) {
        if (chunk.length >= 2 && !STOP_LATIN.has(chunk)) out.push(chunk);
        continue;
      }
      // CJK run: single chars carry little; bigrams are the signal.
      // A bigram made entirely of function words ("的是") carries nothing either.
      // Time words and interrogatives are cut FIRST, per segment — see
      // STOP_TIME_CJK. "今天天气怎么样" must yield only 天气.
      const segs = splitAtCjkStops(chunk);
      for (const seg of segs) {
        for (let i = 0; i + 1 < seg.length; i++) {
          const bg = seg.slice(i, i + 2);
          if (STOP_CJK.has(bg[0]) && STOP_CJK.has(bg[1])) continue;
          out.push(bg);
        }
        // A 1-char segment is usually a real word — 盘 in "G 盘", 删 in
        // "删掉" — and dropping it loses the topic. Fragments are prevented
        // at the cut instead: the full phrase (怎么办, not 怎么 + 办) is in
        // the stop list, so no fragment is left to keep or drop.
        if (seg.length === 1 && !STOP_CJK.has(seg)) out.push(seg);
      }
    }
  }
  return out;
}

export function tokenize(s) { return new Set(tokens(s)); }
export function tokenizeList(s) { return tokens(s); }