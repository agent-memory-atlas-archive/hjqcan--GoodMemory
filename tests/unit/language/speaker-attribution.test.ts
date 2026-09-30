import { describe, expect, it } from "bun:test";
import { createDeterministicMemoryExtractor } from "../../../src/remember/deterministicExtractor";

async function extracted(text: string, locale: string) {
  return (await createDeterministicMemoryExtractor({ defaultLocale: locale }).extract({
    scope: { userId: "attribution-user" }, messages: [{ role: "user", content: text }],
  })).candidates;
}

const rejected = [
  ["en-US", 'If I said "My name is Alice," that would be a lie.'],
  ["en-US", 'If I told you: "My name is Alice." that would be untrue.'],
  ["en-US", 'I said my friend told me: "My name is Alice."'],
  ["en-US", 'I told you my friend replied: "My name is Alice."'],
  ["zh-CN", '我说朋友告诉我：“我叫小林。”'],
  ["en-US", 'I told you that my friend said: "My name is Alice."'],
  ["zh-CN", '我告诉你，朋友说：“我叫小雨。”'],
  ["en-US", 'My friend said "He wrote \\"My name is Soren.\\""'],
  ["en-US", "> My name is Soren."],
  ["en-US", 'My colleague wrote: "My name is Zoe."'],
  ["en-US", 'In my novel, the narrator says "My name is Noah."'],
  ["en-US", "Imagine my name is Oliver."],
  ["en-US", "Suppose my name is Amara."],
  ["en-US", "It is not true that my name is Elena."],
  ["en-US", 'Translate "My name is Lucie." into French.'],
  ["en-US", 'Here is a test string: `My name is Felix.`'],
  ["en-US", 'My colleague says "I am a doctor."'],
  ["zh-CN", "小说里的人物说：“我的名字是夏雨”。这不是我的名字。"],
  ["zh-CN", "朋友留言说：“我叫吴峰。”"],
  ["zh-CN", "假设我叫林舟。"],
  ["zh-CN", "如果我叫林舟，你会怎么称呼我？"],
  ["zh-CN", "这句示例是：『我的名字是安宁。』"],
  ["zh-TW", "小說角色說：「我叫林雨。」"],
  ["zh-CN", "他说：‘我是医生。’"],
  ["zh-CN", "我自己叫他小林。"],
] as const;
const accepted = [
  ["en-US", "> My name is Soren.\nMy name is Maya.", "Maya"],
  ["en-US", "My name is Priya.", "Priya"],
  ["en-US", 'My friend said "My name is Alice." My name is Bob.', "Bob"],
  ["en-US", 'My colleague wrote: "My name is Zoe." My name is Amara.', "Amara"],
  ["en-US", 'My name is "Mira".', "Mira"],
  ["en-US", "My name is O'Connor.", "O'Connor"],
  ["en-US", 'I told them: "My name is Theo."', "Theo"],
  ["zh-CN", "我的名字是林舟。", "林舟"],
  ["zh-CN", "朋友叫小王，我自己叫Lin。", "Lin"],
  ["zh-CN", "朋友说：“我叫吴峰”。我叫林舟。", "林舟"],
  ["zh-CN", "我叫“小禾”。", "小禾"],
  ["zh-CN", "我告诉他：“我叫安宁。”", "安宁"],
  ["zh-TW", "朋友說：「我叫林雨。」我的名字是陳安。", "陳安"],
] as const;

describe("speaker attribution before durable personal extraction", () => {
  it.each([...rejected])("does not adopt a quoted, fictional, or hypothetical speaker: %s %s", async (locale, text) => {
    const candidates = await extracted(text, locale);
    expect(candidates.filter((candidate) => candidate.kindHint === "profile")).toEqual([]);
  });
  it.each([...accepted])("preserves a supported self assertion: %s %s", async (locale, text, name) => {
    const candidates = await extracted(text, locale);
    expect(candidates.filter((candidate) => candidate.metadata?.profileField === "name").map((candidate) => candidate.content)).toEqual([name]);
    expect(candidates.every((candidate) => candidate.sourceMessageIndex === 0)).toBe(true);
  });
});


describe("true self preferences near activity words", () => {
  it.each([
    ["When I write fiction, I prefer short sentences.", "short sentences"],
    ["For translation, I prefer concise answers.", "concise answers"],
    ["I read a lot, and I prefer quiet rooms.", "quiet rooms"],
    ["I translate books, and I prefer quiet rooms.", "quiet rooms"],
    ["I am a character artist and I prefer quiet rooms.", "quiet rooms"],
    ["When I imagine a design, I prefer short sentences.", "short sentences"],
  ])("retains the author's preference: %s", async (text, value) => {
    const candidates = await extracted(text, "en-US");
    expect(candidates.filter((candidate) => candidate.kindHint === "preference").map((candidate) => candidate.metadata?.preferenceValue)).toContain(value);
  });
});


describe("non-personal source integrity", () => {
  it.each([
    ["en-US", "Remember that the deployment command is `bun run build`.", "bun run build"],
    ["en-US", "Always use `bun test` before committing.", "bun test"],
    ["en-US", 'Remember that the production error is "I/O timeout".', "I/O timeout"],
    ["zh-CN", "请记住，构建命令是 `bun run build`。", "bun run build"],
  ])("preserves command and quotation payloads: %s %s", async (locale, text, literal) => {
    const candidates = await extracted(text, locale);
    expect(candidates.some((candidate) => candidate.kindHint !== "profile" && candidate.content.includes(literal))).toBe(true);
  });
});


it("does not turn a conditional Chinese preference into an actual preference", async () => {
  const candidates = await extracted("如果我喜欢喝咖啡，你会推荐哪种？只是举例，我并不喝咖啡。", "zh-CN");
  expect(candidates.filter((candidate) => candidate.kindHint === "preference")).toEqual([]);
});
