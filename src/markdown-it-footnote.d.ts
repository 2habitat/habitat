/**
 * markdown-it-footnote 没有自带类型，社区的 @types 用的是旧版 markdown-it 类型，
 * 与 markdown-it 14 自带的类型冲突（PluginSimple 的 MarkdownIt 不是同一个）。
 * 这里只声明我们真正用到的那一个签名。
 */
declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';
  const footnote: (md: MarkdownIt) => void;
  export default footnote;
}
