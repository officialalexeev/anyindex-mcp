import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { chunkFile } from '../src/chunker.js';
import { NON_CODE_FILES, nonCodeLanguages } from '../src/config.js';

suite('chunker: the non-code list', () => {
  // index_status tells an expected fallback from a failed one by language. Both
  // come from this list, so if the two spellings drift the counters report a
  // markdown file as a parser failure.
  test('every listed extension chunks through the fallback path', async () => {
    for (const { extension, language } of NON_CODE_FILES) {
      const { chunks, strategy } = await chunkFile(`config${extension}`, 'key: value\n');
      assert.equal(strategy, 'fallback', `${extension}: expected the fallback path`);
      for (const chunk of chunks) {
        assert.equal(chunk.language, language, `${extension}: language stored for the counters`);
      }
    }
  });

  test('the language list has no duplicates', () => {
    assert.equal(new Set(nonCodeLanguages).size, nonCodeLanguages.length);
  });
});

suite('chunker: markdown splitting', () => {
  test('a nested heading does not produce a one-line chunk', async () => {
    const content = [
      '# Руководство',
      '',
      '## Первый раздел',
      'Тело первого раздела достаточно длинное, чтобы образовать чанк.',
      '',
      '### 1.1 Подраздел',
      '### 1.2 Ещё один подраздел',
      'Тело последнего подраздела описывает предметную область.',
    ].join('\n');

    const { chunks } = await chunkFile('docs/guide.md', content);

    for (const chunk of chunks) {
      const body = chunk.text
        .split('\n')
        .filter((line) => line.trim() !== '' && !/^#{1,6}\s+\S/.test(line));
      assert.ok(body.length > 0, `chunk ${chunk.lineStart}-${chunk.lineEnd} has no body: ${JSON.stringify(chunk.text)}`);
    }
  });

  test('a heading attaches to its own section, not to the previous one', async () => {
    const content = [
      '## Альфа',
      'Тело альфы.',
      '',
      '## Бета',
      'Тело беты.',
    ].join('\n');

    const { chunks } = await chunkFile('docs/guide.md', content);

    const alpha = chunks.find((c) => c.text.includes('Тело альфы'));
    const beta = chunks.find((c) => c.text.includes('Тело беты'));

    assert.ok(alpha !== undefined && beta !== undefined, 'expected two chunks');
    assert.ok(!alpha.text.includes('Бета'), "beta's heading got glued onto alpha's body");
    assert.ok(beta.text.includes('Бета'), 'the beta chunk has no heading of its own');
  });

  test('a file of nothing but headings is not dropped entirely', async () => {
    const content = ['# Оглавление', '## Раздел один', '## Раздел два'].join('\n');

    const { chunks } = await chunkFile('docs/toc.md', content);

    assert.ok(chunks.length > 0, 'a file with no body must not be dropped entirely');
  });

  test('the start of a file with no heading is not swallowed', async () => {
    const content = ['Вводный абзац без заголовка в начале файла.', '', '## Раздел', 'Тело раздела.'].join(
      '\n',
    );

    const { chunks } = await chunkFile('docs/plain.md', content);

    assert.ok(chunks.some((c) => c.text.includes('Вводный абзац')), 'the opening paragraph was lost');
  });

  test('a chunk split by the size limit takes no name from a prose line', async () => {
    const body = 'Строка документации, которая не должна стать названием раздела в выдаче.';
    const content = ['# Руководство', '', '## Раздел', ...Array.from({ length: 40 }, () => body)].join('\n');

    const { chunks } = await chunkFile('docs/guide.md', content, 400);

    assert.ok(chunks.length > 1, 'need several chunks, otherwise the check means nothing');
    for (const chunk of chunks) {
      assert.equal(chunk.entityName, 'Раздел', `the section name was replaced by a line: ${chunk.entityName}`);
      assert.ok(chunk.contextualizedText.includes('# Section: Раздел'));
    }
  });

  test('a heading inside a fenced block does not become the name', async () => {
    const content = [
      '# Страница',
      '',
      '## Пример',
      '',
      '```yaml',
      'ANYINDEX_ROOT: /absolute/path/to/your/project',
      '```',
      '',
      'Пояснение после блока.',
    ].join('\n');

    const { chunks } = await chunkFile('docs/readme.md', content);

    assert.ok(chunks.length > 0);
    for (const chunk of chunks) {
      assert.ok(
        !chunk.entityName?.includes('ANYINDEX_ROOT'),
        `a config line became the section name: ${chunk.entityName}`,
      );
    }
  });
});
