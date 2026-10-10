import assert from "node:assert/strict";
import test from "node:test";
import { provisionBaseline } from "./provision-baseline.mjs";

test("baseline provisioning stays local unless cloud writes are explicitly approved", async () => {
  const local = await provisionBaseline();
  assert.equal(local.cloudWrite, false);
  assert.equal(local.baseSha, null);
  assert.match(local.digest, /^[a-f0-9]{64}$/);
  const token = "secret-token-value";
  let revoked = false;
  const seeded = await provisionBaseline({
    approveCloudWrite: true,
    artifacts: {
      async create(name) {
        assert.equal(name, "pitcrew-baseline");
        return { name, token };
      },
      async seed(_created, lease) {
        assert.equal(lease, token);
      },
      async head() {
        return "a".repeat(40);
      },
      async revoke(_created, lease) {
        assert.equal(lease, token);
        revoked = true;
      },
    },
  });
  assert.equal(revoked, true);
  assert.equal(seeded.baseSha, "a".repeat(40));
  assert.equal(JSON.stringify(seeded).includes(token), false);
});
