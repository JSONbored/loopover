import { describe, expect, it } from "vitest";
import { gittensoryFooter, gittensorRepoEarnUrl, GITTENSOR_HOME_URL, GITTENSORY_SITE_URL, maintainerControlPanelUrl } from "../../src/github/footer";
import { FORBIDDEN_PUBLIC_COMMENT_WORDS } from "../../src/queue-intelligence";

describe("maintainerControlPanelUrl", () => {
  it("builds the repo maintainer panel URL on the default site origin", () => {
    expect(maintainerControlPanelUrl({}, "owner/repo")).toBe(`${GITTENSORY_SITE_URL}/app?view=maintainer&repo=owner%2Frepo`);
  });

  it("uses a configured PUBLIC_SITE_ORIGIN when present", () => {
    expect(maintainerControlPanelUrl({ PUBLIC_SITE_ORIGIN: "https://panel.test" }, "o/r")).toBe("https://panel.test/app?view=maintainer&repo=o%2Fr");
  });

  it("returns null when the origin cannot form a URL", () => {
    expect(maintainerControlPanelUrl({ PUBLIC_SITE_ORIGIN: "not-a-valid-origin" }, "o/r")).toBeNull();
  });
});

describe("gittensory public-comment footer", () => {
  it("always shows the earn CTA + attribution (permanent marketing surface on every PR)", () => {
    const footer = gittensoryFooter({});
    expect(footer).toMatch(/earn/i);
    expect(footer).toContain("register to start earning");
    expect(footer).toContain(GITTENSOR_HOME_URL);
    expect(footer).toContain(GITTENSORY_SITE_URL);
  });

  it("points the CTA at a specific repo's public miner page when given an earnUrl", () => {
    const footer = gittensoryFooter({}, { earnUrl: gittensorRepoEarnUrl("JSONbored/gittensory") });
    expect(footer).toContain("https://gittensor.io/miners/repository?name=JSONbored%2Fgittensory&tab=miners");
  });

  it("falls back to the Gittensor home URL when no earnUrl is given", () => {
    expect(gittensoryFooter({})).toContain(`(${GITTENSOR_HOME_URL})`);
  });

  it("never uses reward/payout/score wording (would throw in sanitizePublicComment)", () => {
    const footer = gittensoryFooter({}, { earnUrl: gittensorRepoEarnUrl("o/r") }).toLowerCase();
    for (const word of FORBIDDEN_PUBLIC_COMMENT_WORDS) {
      expect(footer).not.toContain(word.toLowerCase());
    }
  });

  it("preserves maintainer custom lead text while appending the Gittensor CTA", () => {
    const earnUrl = gittensorRepoEarnUrl("JSONbored/gittensory");
    const footer = gittensoryFooter({}, { customText: "Thanks for contributing to Gittensory!", earnUrl });
    expect(footer.startsWith("Thanks for contributing to Gittensory!")).toBe(true);
    expect(footer).toContain("register to start earning");
    expect(footer).toContain(earnUrl);
    expect(footer).toContain(GITTENSORY_SITE_URL);
    expect(footer.toLowerCase()).not.toMatch(/reward|payout|score/);
  });

  // #4613: a self-hoster's PUBLIC_SITE_ORIGIN replaces GITTENSORY_SITE_URL in the "Checked by Gittensory"
  // attribution link -- both the default-copy branch and the maintainer-customText branch splice it in,
  // and the Gittensor register link (a separate, shared network) is never rebranded.
  it("#4613: uses PUBLIC_SITE_ORIGIN in the attribution link when configured", () => {
    const footer = gittensoryFooter({ PUBLIC_SITE_ORIGIN: "https://gittensory.example.org" });
    expect(footer).toContain("Checked by [LoopOver](https://gittensory.example.org)");
    expect(footer).not.toContain(GITTENSORY_SITE_URL);
    expect(footer).toContain(GITTENSOR_HOME_URL); // the network link is never rebranded
  });

  it("#4613: falls back to GITTENSORY_SITE_URL when PUBLIC_SITE_ORIGIN is unset", () => {
    expect(gittensoryFooter({})).toContain(`Checked by [LoopOver](${GITTENSORY_SITE_URL})`);
  });

  it("#4613: uses PUBLIC_SITE_ORIGIN in the attribution link on the customText branch too", () => {
    const footer = gittensoryFooter({ PUBLIC_SITE_ORIGIN: "https://gittensory.example.org" }, { customText: "Thanks for contributing!" });
    expect(footer).toContain("Checked by [LoopOver](https://gittensory.example.org)");
    expect(footer).not.toContain(GITTENSORY_SITE_URL);
  });
});
