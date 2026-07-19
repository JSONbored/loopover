import ownPackageJson from "../package.json" with { type: "json" };
/** Package.json semver at import time — the laptop npm-install default. */
export const MINER_PACKAGE_VERSION = ownPackageJson.version;
/** Resolved miner release id: `LOOPOVER_MINER_VERSION` wins when set (fleet Docker image builds). */
export function resolveMinerVersion(env = process.env) {
    const override = typeof env.LOOPOVER_MINER_VERSION === "string" ? env.LOOPOVER_MINER_VERSION.trim() : "";
    return override || MINER_PACKAGE_VERSION;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmVyc2lvbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInZlcnNpb24udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxjQUFjLE1BQU0saUJBQWlCLENBQUMsT0FBTyxJQUFJLEVBQUUsTUFBTSxFQUFFLENBQUM7QUFFbkUsMkVBQTJFO0FBQzNFLE1BQU0sQ0FBQyxNQUFNLHFCQUFxQixHQUFXLGNBQWMsQ0FBQyxPQUFPLENBQUM7QUFFcEUscUdBQXFHO0FBQ3JHLE1BQU0sVUFBVSxtQkFBbUIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUN2RixNQUFNLFFBQVEsR0FBRyxPQUFPLEdBQUcsQ0FBQyxzQkFBc0IsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxzQkFBc0IsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3pHLE9BQU8sUUFBUSxJQUFJLHFCQUFxQixDQUFDO0FBQzNDLENBQUMifQ==