import ownPackageJson from "../package.json" with { type: "json" };

/** Published semver of `@jsonbored/gittensory-engine`, derived from this package's own package.json. */
export const ENGINE_VERSION: string = ownPackageJson.version;
