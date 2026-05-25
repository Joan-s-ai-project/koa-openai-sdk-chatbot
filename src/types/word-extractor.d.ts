declare module 'word-extractor' {
  interface WordDocument {
    getBody(): string
    getFootnotes(): string
    getHeaders(options?: { includeFooters?: boolean }): string
    getHyperlinks(): string[]
  }

  class WordExtractor {
    extract(file: string | Buffer): Promise<WordDocument>
  }

  export = WordExtractor
}
