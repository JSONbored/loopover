import { test } from "node:test";
import assert from "node:assert/strict";

import {
  commandAuthorizationAllowedRoles,
  DEFAULT_COMMAND_AUTHORIZATION_POLICY,
  evaluateCommandAuthorization,
  normalizeCommandAuthorizationPolicy,
} from "../dist/settings/command-authorization.js";

// #9998: the record path seeded `commands` with a SHALLOW spread of DEFAULT_COMMAND_AUTHORIZATION_POLICY,
// so every un-overridden command's role array was the same instance the module-level default holds. A caller
// that mutated a returned array would corrupt the security vocabulary for every repo in the isolate. The
// record path now deep-copies (via clonePolicy) and the default is frozen, matching the non-record exit.
test("#9998: normalizeCommandAuthorizationPolicy({}) returns fresh role arrays, deep-equal but not aliased", () => {
  const policy = normalizeCommandAuthorizationPolicy({}).policy;
  assert.notStrictEqual(policy.commands["review"], DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands["review"]);
  assert.deepEqual(policy.commands["review"], DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands["review"]);
  assert.deepEqual(policy.commands, DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands);
  assert.deepEqual(policy.default, DEFAULT_COMMAND_AUTHORIZATION_POLICY.default);
});

test("#9998: the two exit paths agree — null and an override both return non-aliased arrays for un-overridden commands", () => {
  const fromNull = normalizeCommandAuthorizationPolicy(null).policy;
  assert.notStrictEqual(fromNull.commands["review"], DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands["review"]);

  // Overriding `plan` must not leave the un-overridden `pause` aliased to the default.
  const fromOverride = normalizeCommandAuthorizationPolicy({ commands: { plan: ["maintainer"] } }).policy;
  assert.notStrictEqual(fromOverride.commands["pause"], DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands["pause"]);
  assert.deepEqual(fromOverride.commands["pause"], DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands["pause"]);
});

test("#9998: mutating a returned role array does not change the default, which is frozen", () => {
  const review = normalizeCommandAuthorizationPolicy({}).policy.commands["review"];
  assert.ok(review !== undefined);
  review.push("pr_author");
  assert.deepEqual(DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands["review"], ["maintainer", "collaborator", "confirmed_miner"]);
  assert.equal(Object.isFrozen(DEFAULT_COMMAND_AUTHORIZATION_POLICY.commands["generate-tests"]), true);
});

test("#9998: preserved behaviour — generate-tests stays maintainer-only and denies a COLLABORATOR", () => {
  assert.deepEqual(commandAuthorizationAllowedRoles(null, "generate-tests"), ["maintainer"]);
  assert.equal(
    evaluateCommandAuthorization({ commandName: "generate-tests", commenterAssociation: "COLLABORATOR" }).authorized,
    false,
  );
});
