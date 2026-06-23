declare module "markdown-it" {
  export interface MarkdownItOptions {
    html?: boolean;
    xhtmlOut?: boolean;
    breaks?: boolean;
    langPrefix?: string;
    linkify?: boolean;
    typographer?: boolean;
    quotes?: string | string[];
    highlight?: (str: string, lang: string, attrs: string) => string;
  }

  export interface MarkdownItRendererRuleContext {
    utils: {
      escapeHtml: (str: string) => string;
    };
  }

  export interface MarkdownItToken {
    block?: boolean;
    content: string;
    markup: string;
    info: string;
    tag: string;
    map: [number, number] | null;
    meta: Record<string, unknown> | null;
    attrGet: (name: string) => string | null;
    attrJoin: (name: string, value: string) => void;
  }

  export interface MarkdownItStateBlock {
    src: string;
    line: number;
    lineMax: number;
    blkIndent: number;
    parentType: string;
    silent?: boolean;
    bMarks: number[];
    eMarks: number[];
    tShift: number[];
    sCount: number[];
    push: (type: string, tag: string, nesting: number) => MarkdownItToken;
    getLines: (
      begin: number,
      end: number,
      indent: number,
      keepLastLF: boolean,
    ) => string;
  }

  export interface MarkdownItStateInline {
    src: string;
    pos: number;
    posMax: number;
    pending: string;
    push: (type: string, tag: string, nesting: number) => MarkdownItToken;
  }

  export interface MarkdownItInstance {
    utils: MarkdownItRendererRuleContext["utils"];
    renderer: {
      rules: Record<
        string,
        | ((
            tokens: MarkdownItToken[],
            idx: number,
            options: MarkdownItOptions,
            env: unknown,
            self: MarkdownItRendererRuleContext,
          ) => string)
        | undefined
      >;
    };
    block: {
      ruler: {
        before: (
          beforeName: string,
          ruleName: string,
          rule: (state: MarkdownItStateBlock, startLine: number, endLine: number, silent?: boolean) => boolean,
          options?: { alt?: string[] },
        ) => void;
      };
    };
    inline: {
      ruler: {
        before: (
          beforeName: string,
          ruleName: string,
          rule: (state: MarkdownItStateInline, silent?: boolean) => boolean,
        ) => void;
      };
    };
    render: (src: string, env?: unknown) => string;
    use: (
      plugin: (md: MarkdownItInstance, ...params: unknown[]) => void,
      ...params: unknown[]
    ) => MarkdownItInstance;
  }

  export default class MarkdownIt implements MarkdownItInstance {
    constructor(options?: MarkdownItOptions);
    utils: MarkdownItRendererRuleContext["utils"];
    renderer: MarkdownItInstance["renderer"];
    block: MarkdownItInstance["block"];
    inline: MarkdownItInstance["inline"];
    render: MarkdownItInstance["render"];
    use: MarkdownItInstance["use"];
  }
}

declare module "katex" {
  export interface KatexOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
    output?: "html" | "mathml" | "htmlAndMathml";
  }

  export function renderToString(tex: string, options?: KatexOptions): string;
}
