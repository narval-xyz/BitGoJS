import * as assert from 'assert';

import * as utxolib from '@bitgo/utxo-lib';

import { ParserNode } from '../src/Parser';
import { ScriptParser } from '../src/ScriptParser';

import { formatTreeNoColor, getFixtureString, getTransactionWithSpendType, ParsedFixture } from './fixtures';

function getParser(): ScriptParser {
  return new ScriptParser({ network: utxolib.networks.bitcoin });
}

function testParseScript(type: utxolib.bitgo.outputScripts.ScriptType2Of3) {
  let tx: ParsedFixture;
  before('setup transaction', async function () {
    tx = await getTransactionWithSpendType(utxolib.networks.testnet, 'test/fixtures/parse/psbt', {
      scriptType: type,
      spendType: type === 'p2trMusig2' ? 'scriptPath' : undefined,
      fixtureType: 'psbtFullSigned',
    });
  });

  const parser = getParser();

  function parse(label: string, script: Buffer): ParserNode {
    return parser.node(label, undefined, [parser.parse(script)]);
  }

  it(`parse script ${type}`, async function (this: Mocha.Context) {
    if (tx.transaction instanceof utxolib.bitgo.UtxoTransaction) {
      return this.skip();
    }

    const nodes = tx.transaction.data.inputs.flatMap((input) => {
      return [
        ...(input.redeemScript ? [parse('redeemScript', input.redeemScript)] : []),
        ...(input.witnessScript ? [parse('witnessScript', input.witnessScript)] : []),
      ];
    });

    const root = getParser().node('inputScripts', undefined, nodes);

    const formatted = formatTreeNoColor(root, { showAll: true });

    assert.strictEqual(formatted, await getFixtureString(`test/fixtures/formatScript/${type}.txt`, formatted));
  });
}

utxolib.bitgo.outputScripts.scriptTypes2Of3.forEach((scriptType) => {
  testParseScript(scriptType);
});
