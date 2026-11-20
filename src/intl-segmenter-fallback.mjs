/**
 * yao-pkg's Linux Node.js binaries are built with small-icu, where Intl.Segmenter is replaced by a stub
 * that throws when used. yargs needs it to wrap --help text, so when it's unusable this installs a simple
 * segmenter that splits text into code points (accurate for the plain-ASCII help output).
 */
function isIntlSegmenterUsable() {
  try {
    new Intl.Segmenter().segment('a');
    return true;
  } catch {
    return false;
  }
}

class CodePointSegmenter {
  segment(input) {
    const text = String(input);
    return {
      *[Symbol.iterator]() {
        let index = 0;
        for (const segment of text) {
          yield { segment, index, input: text };
          index += segment.length;
        }
      },
    };
  }

  resolvedOptions() {
    return { locale: 'en', granularity: 'grapheme' };
  }
}

if (!isIntlSegmenterUsable()) {
  Object.defineProperty(Intl, 'Segmenter', { value: CodePointSegmenter, configurable: true, writable: true });
}
