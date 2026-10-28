import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RConsoleProposalError, validateRConsoleProposal } from '../rcode-distiller.js';

const proposal = (code, extra = {}) => ({ language: 'R', target: 'console', code, ...extra });

test('accepts a raw R Console proposal', () => {
  assert.equal(validateRConsoleProposal(proposal('20 + 22')), '20 + 22');
});

test('rejects Markdown before the native endpoint is called', () => {
  assert.throws(
    () => validateRConsoleProposal(proposal('```r\n20 + 22\n```')),
    RConsoleProposalError,
  );
});

test('rejects user prose and proposal field smuggling', () => {
  assert.throws(() => validateRConsoleProposal(proposal('Please run 20 + 22')), RConsoleProposalError);
  assert.throws(() => validateRConsoleProposal(proposal('20 + 22', { approval: 'skip' })), RConsoleProposalError);
});

test('rejects unmistakable JSON and hashbang shell payloads before approval', () => {
  assert.throws(() => validateRConsoleProposal(proposal('{"command":"rm -rf /"}')), RConsoleProposalError);
  assert.throws(() => validateRConsoleProposal(proposal('["echo unsafe"]')), RConsoleProposalError);
  assert.throws(() => validateRConsoleProposal(proposal('#!/bin/sh\necho unsafe')), RConsoleProposalError);
});

test('keeps legitimate R comments, strings, and braced expressions', () => {
  assert.equal(validateRConsoleProposal(proposal('# ordinary R comment\n20 + 22')), '# ordinary R comment\n20 + 22');
  assert.equal(validateRConsoleProposal(proposal('"{\\"not\\": \\"JSON payload\\"}"')), '"{\\"not\\": \\"JSON payload\\"}"');
  assert.equal(validateRConsoleProposal(proposal('{ x <- 20 + 22; x }')), '{ x <- 20 + 22; x }');
});

test('rejects non-R Console targets', () => {
  assert.throws(
    () => validateRConsoleProposal({ language: 'sh', target: 'console', code: 'echo unsafe' }),
    RConsoleProposalError,
  );
});
