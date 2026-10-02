import { describe, expect, it } from 'vitest';
import { tokenize, toTsqueryLiteral, toTsvectorLiteral } from '../src/textIndex';

describe('JA/EN tokenizer', () => {
  it('splits mixed Latin/CJK runs at script boundaries', () => {
    expect(tokenize('ProofFlowは10月公開予定').map((t) => t.t)).toEqual(['proofflow', 'は', '10', '月公', '公開', '開予', '予定']);
  });
  it('bigrams CJK and lowercases Latin; NFKC normalizes full-width', () => {
    expect(tokenize('価格変更 ＡＢＣ').map((t) => t.t)).toEqual(['価格', '格変', '変更', 'abc']);
  });
  it('builds phrase queries and prefix for single CJK char', () => {
    expect(toTsqueryLiteral('価格変更')).toBe("('価格' <-> '格変' <-> '変更')");
    expect(toTsqueryLiteral('円')).toBe("'円':*");
    // '月' alone is never indexed inside a longer CJK run ("10月公開" -> '10','月公','公開'), so it is a prefix match.
    expect(toTsqueryLiteral('10月 公開')).toBe("('10' <-> '月':*) & '公開'");
    expect(toTsqueryLiteral('  ')).toBeNull();
  });
  it('escapes quotes and backslashes (no tsquery syntax injection)', () => {
    expect(toTsvectorLiteral("it's")).toBe("'it':1 's':2");
    expect(toTsqueryLiteral("a' | b")).toBe("'a' & 'b'");
  });
});
