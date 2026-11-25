/**
 * x-bark-delivery — X -> Bark (Cloudflare Worker, free tier).
 *
 * Chain: GitHub Actions poll.py (twifork) POSTs candidate tweets to
 * POST /ingest with a shared WORKER_TOKEN. This Worker dedupes in KV
 * (only writes on new posts), translates with Workers AI
 * (llama-3.1-8b-instruct-fp8-fast, same glossary / billion guard /
 * TRIM LOSSES guard as tg-firstsquawk-translate — the translation code
 * below is copied verbatim from that Worker), then pushes Bark to
 * iPhone + iPad (level=timeSensitive, group per source).
 *
 * Env (secrets, never in code):
 *   WORKER_TOKEN  shared token poll.py must send as Bearer
 *   BARK_KEY      iPhone Bark key (22-char, from Bark app)
 *   BARK_KEY_IPAD iPad Bark key
 * Bindings:
 *   AI  Workers AI binding
 *   STATE KV namespace (x-bark-state): last:<source> + seen:<tweet id>
 *
 * Routes:
 *   GET  /          health check
 *   GET  /test?text=...&source=FirstSquawk  translate only, no Bark
 *   GET  /testbark?text=...&source=FirstSquawk  translate + Bark push
 *   GET  /status    last seen ids + last poll time
 *   POST /ingest    {tweets:[{id,text,source,url,created_at}]}
 */

// 金融术语表：小模型直译容易错的词先在 prompt 里定死。
// 2026-11-24 补充人名：3B 小模型会把 JENSEN HUANG 音译成
// "吉森·安·安·安"，还会混进越南语（EMPLOYEES -> nhân viên）。
// 2026-11-25 补充 ANTHROPIC：用户报 FirstSquawk 把 Anthropic 翻成
// "人类学"。Anthropic 是公司名（Claude 背后公司），没有标准中文名，
// 一律保留英文不翻译；同理 OPENAI 保留英文。
// 2026-11-26 补充 TRIM/PARE/EXTEND LOSSES/GAINS：用户报 Walter Bloomberg
// "TRIM LOSSES, LAST DOWN 0.65% AND 1.4%" 被翻成"收盘时分别缩减了
// 0.65% 和 1.4%"——丢了"收窄跌幅"的反弹信号，还凭空加了"收盘时"。
const GLOSSARY =
  "SHORT POSITION=空头头寸, SHORT SELLER=做空机构, MUDDY WATERS=浑水, " +
  "DOWNGRADE=下调评级, UPGRADE=上调评级, STAKE=持股, BEAT=超预期, " +
  "MISS=不及预期, RATE CUT=降息, RATE HIKE=加息, INFLATION=通胀, " +
  "SHORT INTEREST=空头持仓占比, JENSEN HUANG=黄仁勋, NVIDIA=英伟达, " +
  "JEROME POWELL=鲍威尔, DONALD TRUMP=特朗普, ELON MUSK=马斯克, " +
  "SCOTT BESSENT=贝森特, KEVIN WARSH=沃什, FED=美联储, " +
  "FEDERAL RESERVE=美联储, WHITE HOUSE=白宫, TARIFF=关税, EARNINGS=财报, " +
  "VICE PRESIDENT=副总统, JD VANCE=万斯, SEMAFOR=Semafor, " +
  "MEGASPEED=Megaspeed, TRUMP ADMINISTRATION=特朗普政府, " +
  "COMMERCE DEPARTMENT=商务部, ENTITY LIST=实体清单, " +
  "TRIM LOSSES=收窄跌幅, TRIMMED LOSSES=收窄跌幅, TRIM GAINS=收窄涨幅, " +
  "TRIMMED GAINS=收窄涨幅, PARE LOSSES=收窄跌幅, PARE GAINS=收窄涨幅, " +
  "NARROW LOSSES=收窄跌幅, EXTEND LOSSES=扩大跌幅, EXTEND GAINS=扩大涨幅, " +
  "ANTHROPIC=Anthropic, OPENAI=OpenAI, " +
  "UNUSUAL WHALES=Unusual Whales, CHEDDARFLOW=Cheddarflow";

// 兜底：prompt 里的术语表只是提示，8B 小模型仍可能无视（Anthropic
// 就翻车过一次）。原文含 Anthropic 时，译文里出现的人类学／音译一律
// 强制改回 Anthropic；这道是确定性的，不依赖模型听话。
// 同理 OpenAI：若原文有 OpenAI，译文里的"开放人工智能"改回 OpenAI。
// 2026-11-26 补充 Unusual Whales / Cheddarflow：用户报 Unusual Whales
// 被翻成"异常大鲸鱼"。两个都是来源品牌名，一律保留英文不翻译。
function fixUntranslatableNames(orig, zh) {
  let out = String(zh || "");
  if (/anthropic/i.test(orig || "")) {
    out = out.replace(/人类学/g, "Anthropic").replace(/安索普克/g, "Anthropic").replace(/安思罗普克/g, "Anthropic");
  }
  if (/openai/i.test(orig || "")) {
    out = out.replace(/开放人工智能/g, "OpenAI");
  }
  if (/unusual whales/i.test(orig || "")) {
    out = out
      .replace(/异常大鲸鱼/g, "Unusual Whales")
      .replace(/异常鲸鱼/g, "Unusual Whales")
      .replace(/不寻常的鲸鱼/g, "Unusual Whales")
      .replace(/不寻常鲸鱼/g, "Unusual Whales")
      .replace(/非同寻常的鲸鱼/g, "Unusual Whales")
      .replace(/异常的鲸鱼/g, "Unusual Whales");
  }
  if (/cheddarflow/i.test(orig || "")) {
    out = out
      .replace(/切达流/g, "Cheddarflow")
      .replace(/切达福洛/g, "Cheddarflow")
      .replace(/奶酪流/g, "Cheddarflow")
      .replace(/车打流/g, "Cheddarflow");
  }
  return out;
}

// Billion/million/trillion 确定性换算 guard（2026-11-25，用户点选加）。
// 根因：1 billion = 10亿、1 million = 100万、1 trillion = 1万亿，
// 但 LLM 与 m2m100 都经常直接照抄英文数字配中文单位（$13B -> "13亿
// 美元"，少 10 倍；$350B -> "350亿美元"，少 10 倍；偶尔又多 10 倍
// 变成 1300亿）。temperature 0 也没根治，所以最后用确定性规则兜底。
// 只修一种能确诊的情况：译文里的数字恰好等于原文的英文数字、且换算
// 后的值对不上（即模型照抄了数字没换算）。值已经对的、以及无法确诊
// 的乱写（如 1300亿），一律不动，宁可漏修也不错修。
// 顺序无关：按数值匹配，不按出现顺序，避免译文调换两数顺序时修错。
const fmtNum = (v) => String(Math.round(v * 10000) / 10000);

function fixLargeNumbers(orig, zh) {
  let out = String(zh || "");
  const src = String(orig || "");
  // 原文的大单位数字，按出现顺序记下来（n=英文数字，expectedWan=以"万"为
  // 单位的正确值，canonical=正确中文写法）。
  const figs = [];
  const srcRe = /(\d[\d,]*\.?\d*)\s*(trillions?|billions?|millions?|bn)\b|\$\s*(\d[\d,]*\.?\d*)\s*([BM])\b/gi;
  for (const m of src.matchAll(srcRe)) {
    let n, kind;
    if (m[1] !== undefined) {
      n = parseFloat(m[1].replace(/,/g, ""));
      kind = m[2].toLowerCase().replace(/s$/, "");
      if (kind === "bn") kind = "billion";
    } else {
      n = parseFloat(m[3].replace(/,/g, ""));
      kind = m[4] === "B" ? "billion" : "million";
    }
    if (!isFinite(n)) continue;
    if (kind === "trillion") {
      figs.push({ n, kind, expectedWan: n * 1e8, canonical: fmtNum(n) + "万亿", done: false });
    } else if (kind === "billion") {
      figs.push({ n, kind, expectedWan: n * 1e5, canonical: fmtNum(n * 10) + "亿", done: false });
    } else if (kind === "million") {
      figs.push({
        n,
        kind,
        expectedWan: n * 100,
        canonical: n >= 100 ? fmtNum(n / 100) + "亿" : fmtNum(n * 100) + "万",
        done: false,
      });
    }
  }
  if (!figs.length) return out;
  const close = (a, b) => Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.01);
  const findByValue = (wan) => figs.find((f) => !f.done && close(wan, f.expectedWan));
  const findByRawNum = (num) => figs.find((f) => !f.done && f.n === num);

  // 第一遍：译文里残留的英文大单位（如模型原样吐出 "$13 billion"），
  // 直接换成正确中文。带 $ 的补"美元"。
  out = out.replace(
    /\$?\s*(\d[\d,]*\.?\d*)\s*(trillions?|billions?|millions?|bn)\b|\$\s*(\d[\d,]*\.?\d*)\s*([BM])\b/gi,
    (whole, n1, k1, n2, k2) => {
      const hasDollar = whole.trimStart().startsWith("$");
      let n, kind;
      if (n1 !== undefined) {
        n = parseFloat(n1.replace(/,/g, ""));
        kind = k1.toLowerCase().replace(/s$/, "");
        if (kind === "bn") kind = "billion";
      } else {
        n = parseFloat(n2.replace(/,/g, ""));
        kind = k2 === "B" ? "billion" : "million";
      }
      const fig = figs.find((f) => !f.done && f.n === n && f.kind === kind);
      if (!fig) return whole;
      fig.done = true;
      return fig.canonical + (hasDollar ? "美元" : "");
    },
  );

  // 第二遍：译文里的中文大单位金额（"13亿美元"、"350亿"、"13百万"等）。
  // 单位换算成"万"：万亿=1e8，亿=1e4，千万=1000，百万=100，万=1。
  const unitMult = { "万亿": 1e8, "亿": 1e4, "千万": 1000, "百万": 100, "万": 1 };
  const zhRe = /(\d[\d,]*\.?\d*)\s*(万亿|千万|百万|亿|万)\s*(美元|美金|元)?/g;
  const matches = [...out.matchAll(zhRe)];
  // 从后往前替换，下标不移位。
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const num = parseFloat(m[1].replace(/,/g, ""));
    const mult = unitMult[m[2]];
    const gotWan = num * mult;
    const currency = m[3] || "";
    if (findByValue(gotWan)) {
      findByValue(gotWan).done = true;
      continue; // 值已经对了，不动
    }
    const fig = findByRawNum(num);
    if (!fig || close(gotWan, fig.expectedWan)) continue;
    // 数字与原文英文数字相同、值却不对 = 照抄没换算，确诊，修掉。
    fig.done = true;
    out = out.slice(0, m.index) + fig.canonical + currency + out.slice(m.index + m[0].length);
  }
  return out;
}

// 捏造收盘 guard（2026-11-26）：模型常把 LAST（最新报价）翻成"收盘时"，
// 在盘中快讯里是凭空捏造的事实（02:19 SGT 那条发时美股还没收盘）。
// 原文没有 close/closing/settle 这类词时，译文里的"收盘"一律是编的，
// 改成"最新"。原文真有 close 时不动。确定性规则，不依赖模型听话。
function fixInventedClose(orig, zh) {
  if (/\bclos(e|es|ed|ing)\b|\bsettle(d)?\b/i.test(String(orig || ""))) return zh;
  return String(zh || "")
    .replace(/收盘时/g, "最新")
    .replace(/收盘价/g, "最新价")
    .replace(/收盘/g, "最新");
}

// m2m100 残留 guard（2026-11-26）：m2m100 不读 prompt 里的术语表，
// "TRIM LOSSES" 常被原样留在中文里（"NASDAQ TRIM的损失……"）。LLM
// 是主路、很少走到 m2m100，但走到时也别把英文词原样推给用户。
function fixLeftoverTrim(orig, zh) {
  let out = String(zh || "");
  if (!/trim/i.test(orig || "") || !/TRIM/i.test(out)) return out;
  out = out
    .replace(/TRIM的损失/g, "收窄跌幅")
    .replace(/TRIM损失/g, "收窄跌幅")
    .replace(/TRIM的收益/g, "收窄涨幅")
    .replace(/TRIM的涨幅/g, "收窄涨幅");
  return out;
}

function finalizeZh(orig, zh) {
  return fixLargeNumbers(orig, fixUntranslatableNames(orig, fixLeftoverTrim(orig, fixInventedClose(orig, zh))));
}

// 注：这里曾有一份只管 billion、且仅当原文和译文各恰好 1 个数字时才修的
// fixBillionNumbers，已合并删除、只留上面的 fixLargeNumbers 一份 guard。
// 原因：单数字版对用户那句 "$13B at $350B valuation"（两个数字）直接
// 不修；fixLargeNumbers 按数值匹配、只修确诊的照抄未换算，且覆盖
// million／trillion，顺序调换也不会修错。
// 分隔线判定：一行全是 _ — - – =（2 个以上）就是 Xanguard 的 ____ 分隔线，
// 不是正文。2026-11-24 实测教训：旧 extract 只取前两条分隔线之间，
// 顶部两条分隔线连在一起时夹出的正文为空，就掉回 fallback 分支，
// 而 fallback 不删分隔线，分隔线原样进了翻译、私聊里满是横线。
const isDividerLine = (s) => /^[_—\-–=]{2,}\s*$/.test(s.trim());

// 清掉文本里所有分隔线行，并把正文里残留的 -- / - - 并成单个 -。
function stripDividerLines(text) {
  return String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((t) => t && !isDividerLine(t))
    .join("\n")
    .replace(/-{2,}/g, "-")
    .replace(/\s+-\s+-\s+/g, " - ")
    .trim();
}

// 长文分段：llama-3.2-3b 默认输出上限只有 256 tokens，长帖会被拦腰
// 截断（2026-11-24 实测：Megaspeed 五段只翻出一段半、Vance 五段只翻
// 两段、Citadel 翻到一半开始复读同一句）。超过 600 字的正文按段落／
// 句子切块逐块翻译再拼接；每块单独调模型。
const MAX_CHUNK_CHARS = 600;

function splitIntoChunks(text) {
  // 贪心打包：短段落并进同一块（给模型更多上下文、减少调用次数），
  // 单个超长段落再按句子切。
  const paras = String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = "";
  const push = (s) => {
    if (s.trim()) chunks.push(s.trim());
  };
  for (const p of paras) {
    if (p.length > MAX_CHUNK_CHARS) {
      const sents = p.match(/[^。！？；.!?]+[。！？；.!?]?/g) || [p];
      for (const s of sents) {
        if (cur && (cur + "\n" + s).length > MAX_CHUNK_CHARS) {
          push(cur);
          cur = s;
        } else {
          cur = cur ? cur + "\n" + s : s;
        }
      }
      continue;
    }
    if (cur && (cur + "\n" + p).length > MAX_CHUNK_CHARS) {
      push(cur);
      cur = p;
    } else {
      cur = cur ? cur + "\n" + p : p;
    }
  }
  push(cur);
  return chunks.length ? chunks : [text];
}

// 去掉连续重复的句子：3B 小模型长文输出会复读同一句（2026-11-24
// Citadel 翻译同一句出现三次）。只去紧邻的完全相同的句子，不动
// 正常内容。输入输出两端都过一遍。
function dedupeSentences(text) {
  const lines = String(text).split("\n");
  const outLines = [];
  for (const line of lines) {
    const sents = line.match(/[^。！？]+[。！？]?/g) || [];
    const kept = [];
    for (const s of sents) {
      const t = s.trim();
      if (!t) continue;
      if (kept.length && kept[kept.length - 1].trim() === t) continue;
      kept.push(s);
    }
    const joined = kept.join("").trim();
    if (!joined) continue;
    if (outLines.length && outLines[outLines.length - 1] === joined) continue;
    outLines.push(joined);
  }
  return outLines.join("\n").trim();
}

// Xanguard 的消息是多行的：首行是账号头（@Deltaone · Walter Bloomberg · 2.0M ·
// Tweet），正文夹在两条分隔线（____）之间，末尾是 "Delivered by @Xanguard_bot"。
// 只翻正文：不管分隔线在哪、连着出现几条，一律删掉；头尾的样板行也不翻，
// 免得中文私聊里只剩 "布隆伯格 · 华尔特 · 2.0M"。
function extractTweetBody(text) {
  const lines = String(text || "").split("\n");
  const kept = lines.filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (isDividerLine(t)) return false;
    if (/^Delivered by\b/i.test(t)) return false;
    if (/^@\S+.*\bTweet\b/i.test(t)) return false;
    // TwitGram 格式的样板行，不是正文：
    // "🆕 New Original Tweet Alert 🆕"、"From: FirstSquawk"、"Tweet Text:"。
    if (/new .{0,40} alert/i.test(t) && t.length < 60) return false;
    if (/^From:\s*\S+/i.test(t)) return false;
    if (/^Tweet Text:\s*$/i.test(t)) return false;
    return true;
  });
  const out = kept.join("\n").trim();
  return out || stripDividerLines(text);
}

async function translateViaLlm(env, text) {
  // 2026-11-24：主模型由 3B 換成 8B fp8-fast——同為免費額度內，質量明顯
  // 好一檔（專有名詞、長句更穩）；fp8-fast 版每條約 4 neurons，一天
  // 300 多條約 1,300，遠低於免費額度 10,000。普通 8B 版每條約 16
  // neurons，長文分塊時可能逼近上限，故不用。
  const out = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8-fast", {
    messages: [
      {
        role: "system",
        content:
          "You translate English financial news headlines into Simplified Chinese. " +
          "Output ONLY the Chinese translation, nothing else. Translate the full " +
          "text faithfully and completely, paragraph by paragraph; do not summarize, " +
          "omit, add or invent anything. Translate once only; " +
          "never repeat any sentence or phrase. Use ONLY Simplified " +
          "Chinese characters for the translated words; never output Vietnamese, " +
          "English or any other language. Keep stock tickers, numbers, percentages " +
          "and symbols unchanged. Convert large units correctly: 1 billion is 10亿, " +
          "so $13 billion must become 130亿美元 and $350 billion must become 3500亿美元; " +
          "1 million is 100万, so $13 million must become 1300万美元; never just copy " +
          "the English digit unchanged in front of 亿 or 万. In market headlines, LAST means 最新 (the latest quote), never 收盘时; " +
          "DOWN x% means 下跌x% (currently down by x%), UP x% means 上涨x%; keep TRIM LOSSES (收窄跌幅) and DOWN x% as two separate ideas, " +
          "never merge them into 缩减了x% or 下跌了x% as the amount trimmed. Keep company names that have no standard Chinese " +
          "name in English; for example Anthropic must stay Anthropic and never " +
          "be translated as 人类学. Use these terms: " +
          GLOSSARY + ".",
      },
      { role: "user", content: text },
    ],
    // 2026-11-24 教训：不设 max_tokens 时默认只有 256，长帖翻到一半就断。
    // 2026-11-25：temperature 0——默认采样下同一句 "$13 billion / $350
    // billion" 三次测出 3亿/50亿、130亿/3500亿、13亿/3500亿三种结果，
    // 数字漂移对交易快讯是致命的；temperature 0 让输出确定性最高。
    max_tokens: 2048,
    temperature: 0,
  });
  const raw = out && out.response ? String(out.response) : "";
  // 注意：不要只取第一行——Xanguard/TwitGram 的消息是多行的，正文在
  // 后面，只取首行会把正文截掉（2026-11-24 实测：私聊只剩
  // "布隆伯格 · 华尔特 · 2.0M ·"）。取全文，去掉空行。
  // 再过一道 stripDividerLines：模型有时会把输入里的 ____ 原样吐出来，
  // 不能让分隔线漏进私聊。
  const full = stripDividerLines(raw.split("\n").map((s) => s.trim()).filter(Boolean).join("\n"));
  return { text: full, raw: raw.slice(0, 200) };
}

async function translateViaM2m(env, text) {
  const out = await env.AI.run("@cf/meta/m2m100-1.2b", {
    text,
    source_lang: "english",
    target_lang: "chinese",
  });
  return out && out.translated_text ? stripDividerLines(String(out.translated_text).trim()) : "";
}

// Azure AI Translator（主路，2026-11-24 接入）：专用 NMT 引擎，英翻中质量
// 好于 3B 小模型。F0 免费版每月 200 万字符；没配 key、调用失败或额度
// 用完时返回 null，由调用方回落到 Workers AI，推送不中断。长文一次
// 发全文（单请求上限 5 万字符），不需要像 LLM 那样分块。
async function translateViaAzure(env, text) {
  const key = (env.AZURE_TRANSLATOR_KEY || "").trim();
  if (!key) return null;
  const headers = {
    "Content-Type": "application/json",
    "Ocp-Apim-Subscription-Key": key,
  };
  const region = (env.AZURE_TRANSLATOR_REGION || "").trim();
  if (region) headers["Ocp-Apim-Subscription-Region"] = region;
  const resp = await fetch(
    "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans",
    { method: "POST", headers, body: JSON.stringify([{ Text: text }]) }
  );
  if (!resp.ok) throw new Error(`azure HTTP ${resp.status}`);
  const data = await resp.json().catch(() => null);
  const out =
    data && data[0] && data[0].translations && data[0].translations[0] &&
    data[0].translations[0].text;
  return out ? stripDividerLines(String(out).trim()) : null;
}

async function translateToZh(env, text, forceVia) {
  if (!env.AI) throw new Error("Workers AI binding missing");
  const clean = dedupeSentences(text);
  if (forceVia === "azure") {
    const zh = await translateViaAzure(env, clean);
    if (!zh) throw new Error("azure unavailable (no key or call failed)");
    return { zh: finalizeZh(clean, dedupeSentences(zh)), via: "azure", llm_note: "" };
  }
  // 默认：Azure 优先，失败或未配置时回落到 LLM 分块，再到 m2m100。
  try {
    const zh = await translateViaAzure(env, clean);
    if (zh) return { zh: finalizeZh(clean, dedupeSentences(zh)), via: "azure", llm_note: "" };
  } catch (e) {
    console.log("azure translate failed, falling back to llm:", String(e).slice(0, 120));
  }
  const chunks = splitIntoChunks(clean);
  const parts = [];
  let llmNote = "";
  let allLlm = true;
  for (const chunk of chunks) {
    if (forceVia === "m2m100") {
      allLlm = false;
      const zh = await translateViaM2m(env, chunk);
      if (zh) parts.push(zh);
      continue;
    }
    try {
      const r = await translateViaLlm(env, chunk);
      if (r.text) {
        parts.push(r.text);
        continue;
      }
      llmNote = `llm-empty raw=${r.raw.slice(0, 120)}`;
    } catch (e) {
      llmNote = `llm-error ${String(e).slice(0, 120)}`;
      console.log("llm translate failed, falling back to m2m100:", String(e));
    }
    allLlm = false;
    const zh = await translateViaM2m(env, chunk);
    if (zh) parts.push(zh);
  }
  const joined = finalizeZh(clean, dedupeSentences(parts.join("\n")));
  return { zh: joined, via: allLlm ? (chunks.length > 1 ? `llm-chunked-${chunks.length}` : "llm") : (forceVia === "m2m100" ? "m2m100" : "mixed"), llm_note: llmNote };
}


// ---- Bark (copied pattern from tv-telegram worker.js) ----
const BARK_SERVER = "https://api.day.app";

async function sendBarkTo(env, title, body, group, url, key) {
  try {
    const resp = await fetch(`${BARK_SERVER}/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title, body, group,
        level: "timeSensitive",
        url: url || undefined,
        isArchive: 1,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok && data.code === 200, status: resp.status, detail: data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function sendBark(env, title, body, group, url) {
  const keys = [env.BARK_KEY, env.BARK_KEY_IPAD].map((k) => (k || "").trim()).filter(Boolean);
  if (!keys.length) return { ok: false, skipped: true, error: "BARK_KEY not configured" };
  const results = await Promise.all(keys.map((k) => sendBarkTo(env, title, body, group, url, k)));
  const okCount = results.filter((r) => r.ok).length;
  if (okCount === keys.length) return { ok: true, detail: `all ${keys.length} bark keys ok` };
  if (okCount > 0) return { ok: true, partial: true, detail: `${okCount}/${keys.length} bark keys ok` };
  return { ok: false, error: results.map((r) => r.error || `status ${r.status}`).join("; ") };
}

function sourceLabel(source) {
  if (source === "Unusual Whales") return "Unusual Whales";
  if (source === "Cheddarflow") return "Cheddarflow";
  return String(source || "X");
}

// Tweet time as "5:16pm" in SGT (Asia/Singapore, 12-hour). Uses the tweet's
// created_at; falls back to now when it is missing or unparseable.
function sgtTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Singapore", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(d);
  const h = parts.find((p) => p.type === "hour").value;
  const m = parts.find((p) => p.type === "minute").value;
  const ap = parts.find((p) => p.type === "dayPeriod").value.toLowerCase();
  return `${h}:${m}${ap}`;
}

async function pushOne(env, tweet) {
  const label = sourceLabel(tweet.source);
  const text = extractTweetBody(tweet.text || "");
  if (!text) return { skipped: "empty body", id: tweet.id };
  let tr;
  try {
    tr = await translateToZh(env, text);
  } catch (e) {
    console.log("translate failed:", String(e));
    return { skipped: "translate failed", id: tweet.id };
  }
  if (!tr.zh || tr.zh === text) return { skipped: "no translation", id: tweet.id };
  const t = sgtTime(tweet.created_at);
  const body = t ? `${stripDividerLines(tr.zh)} (${t} SGT)` : stripDividerLines(tr.zh);
  const bk = await sendBark(env, label, body, label, tweet.url || "");
  return { ok: bk.ok, id: tweet.id, via: tr.via, bark: bk, body };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("x-bark-delivery ok", { status: 200 });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const kv = env.STATE;
      const out = {};
      if (kv) {
        for (const s of ["Unusual Whales", "Cheddarflow"]) {
          out[`last:${s}`] = await kv.get(`last:${s}`);
        }
        out.lastPollAt = await kv.get("lastPollAt");
      }
      return new Response(JSON.stringify({ ok: true, ...out }, null, 2), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (request.method === "GET" && (url.pathname === "/test" || url.pathname === "/testbark")) {
      const text = extractTweetBody((url.searchParams.get("text") || "").trim());
      const source = url.searchParams.get("source") || "FirstSquawk";
      if (!text) return new Response("usage: /test?text=hello&source=FirstSquawk", { status: 400 });
      try {
        const tr = await translateToZh(env, text);
        const t = sgtTime();
        const body = t ? `${stripDividerLines(tr.zh)} (${t} SGT)` : stripDividerLines(tr.zh);
        if (url.pathname === "/test") {
          return new Response(JSON.stringify({ ok: true, zh: body, via: tr.via }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        const bk = await sendBark(env, sourceLabel(source), body, sourceLabel(source), "");
        return new Response(JSON.stringify({ ok: bk.ok, zh: body, via: tr.via, bark: bk }), {
          status: bk.ok ? 200 : 500, headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }
    if (request.method === "POST" && url.pathname === "/ingest") {
      const token = (env.WORKER_TOKEN || "").trim();
      if (token) {
        const got = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        if (got !== token) return new Response("forbidden", { status: 403 });
      }
      let payload = null;
      try { payload = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
      const tweets = Array.isArray(payload && payload.tweets) ? payload.tweets : [];
      const kv = env.STATE;
      if (kv) {
        try { await kv.put("lastPollAt", new Date().toISOString()); } catch (e) { console.log("kv lastPollAt failed:", String(e)); }
      }
      const results = [];
      for (const t of tweets) {
        const id = String(t.id || "");
        const label = sourceLabel(t.source);
        if (!id) { results.push({ skipped: "no id" }); continue; }
        if (kv) {
          // Burst guard: seen id within 24h -> skip even if last: pointer moved.
          try {
            if (await kv.get(`seen:${id}`)) { results.push({ skipped: "seen", id }); continue; }
          } catch (e) { console.log("kv seen read failed:", String(e)); }
        }
        const r = await pushOne(env, t);
        results.push(r);
        if (kv && r.ok) {
          try {
            await kv.put(`seen:${id}`, "1", { expirationTtl: 86400 });
            await kv.put(`last:${label}`, id);
          } catch (e) { console.log("kv write failed:", String(e)); }
        }
      }
      const pushed = results.filter((r) => r.ok).length;
      return new Response(JSON.stringify({ ok: true, received: tweets.length, pushed, results }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  },
};
