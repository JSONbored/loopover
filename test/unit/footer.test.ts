import { describe, expect, it } from "vitest";
import { gittensoryFooter, gittensorRepoEarnUrl, GITTENSOR_HOME_URL, GITTENSORY_SITE_URL } from "../../src/github/footer";
import { FORBIDDEN_PUBLIC_COMMENT_WORDS } from "../../src/queue-intelligence";

describe("gittensory public-comment footer", () => {
  it("always shows the earn CTA + attribution (permanent marketing surface on every PR)", () => {
    const footer = gittensoryFooter();
    expect(footer).toMatch(/earn/i);
    expect(footer).toContain("register to start earning");
    expect(footer).toContain(GITTENSOR_HOME_URL);
    expect(footer).toContain(GITTENSORY_SITE_URL);
  });

  it("points the CTA at a specific repo's public miner page when given an earnUrl", () => {
    const footer = gittensoryFooter({ earnUrl: gittensorRepoEarnUrl("JSONbored/gittensory") });
    expect(footer).toContain("https://gittensor.io/miners/repository?name=JSONbored%2Fgittensory&tab=miners");
  });

  it("falls back to the Gittensor home URL when no earnUrl is given", () => {
    expect(gittensoryFooter()).toContain(`(${GITTENSOR_HOME_URL})`);
  });

  it("never uses reward/payout/score wording (would throw in sanitizePublicComment)", () => {
    const footer = gittensoryFooter({ earnUrl: gittensorRepoEarnUrl("o/r") }).toLowerCase();
    for (const word of FORBIDDEN_PUBLIC_COMMENT_WORDS) {
      expect(footer).not.toContain(word.toLowerCase());
    }
  });
});
