import assert from 'assert';

import { Descriptor } from '@bitgo/wasm-miniscript';
import { Triple } from '@bitgo/sdk-core';
import { BIP32Interface } from '@bitgo/utxo-lib';
import { getKeyTriple } from '@bitgo/utxo-core/testutil';

import { DescriptorTemplate, getDescriptor } from '../../../../utxo-core/src/testutil/descriptor/descriptors';
import {
  assertDescriptorPolicy,
  DescriptorPolicyValidationError,
  DescriptorValidationPolicy,
  getPolicyForEnv,
  getValidatorDescriptorTemplate,
} from '../../../src/descriptor/validatePolicy';
import { NamedDescriptor, createNamedDescriptorWithSignature } from '../../../src/descriptor';

function testAssertDescriptorPolicy(
  d: NamedDescriptor<string>,
  p: DescriptorValidationPolicy,
  k: Triple<BIP32Interface>,
  expectedError: DescriptorPolicyValidationError | null
) {
  const f = () => assertDescriptorPolicy(Descriptor.fromString(d.value, 'derivable'), p, k, d.signatures ?? []);
  if (expectedError) {
    assert.throws(f);
  } else {
    assert.doesNotThrow(f);
  }
}

describe('assertDescriptorPolicy', function () {
  const keys = getKeyTriple();
  function getNamedDescriptor(name: DescriptorTemplate): NamedDescriptor {
    return createNamedDescriptorWithSignature(name, getDescriptor(name), keys[0]);
  }
  function stripSignature(d: NamedDescriptor): NamedDescriptor {
    return { ...d, signatures: undefined };
  }

  it('has expected result', function () {
    testAssertDescriptorPolicy(getNamedDescriptor('Wsh2Of3'), getValidatorDescriptorTemplate('Wsh2Of3'), keys, null);

    // prod does only allow Wsh2Of3-ish descriptors
    testAssertDescriptorPolicy(getNamedDescriptor('Wsh2Of3'), getPolicyForEnv('prod'), keys, null);

    // prod only allows other descriptors if they are signed by the user key
    testAssertDescriptorPolicy(getNamedDescriptor('Wsh2Of2'), getPolicyForEnv('prod'), keys, null);
    testAssertDescriptorPolicy(
      stripSignature(getNamedDescriptor('Wsh2Of2')),
      getPolicyForEnv('prod'),
      keys,
      new DescriptorPolicyValidationError(getDescriptor('Wsh2Of2'), getPolicyForEnv('prod'))
    );

    // test is very permissive by default
    testAssertDescriptorPolicy(stripSignature(getNamedDescriptor('Wsh2Of2')), getPolicyForEnv('test'), keys, null);
  });
});
