# Kubernetes manifests — gittensory-miner (AMS) fleet mode

Example manifests for running **N isolated miner workers** on a small Kubernetes cluster, as an alternative to
`docker run` / docker-compose on a single host. Built on the existing
[`packages/gittensory-miner/Dockerfile`](../packages/gittensory-miner/Dockerfile) image (see
[`DEPLOYMENT.md`](../packages/gittensory-miner/DEPLOYMENT.md) for the fleet-mode overview). These are starting
points — review resource sizing, storage class, and your registry before applying to a real cluster.

## Why a StatefulSet (not a Deployment)

The miner keeps all state in **local SQLite ledgers** (`claim-ledger.sqlite3`, `plan-store.sqlite3`, …) under
`GITTENSORY_MINER_CONFIG_DIR` (`/data/miner`). Those stores are **not safe for concurrent multi-pod access**, so
each worker needs its **own** volume. A Deployment can only mount a single shared PVC across every replica; a
**StatefulSet's `volumeClaimTemplates`** give each replica its own PersistentVolumeClaim — so scaling to N
replicas yields N workers with fully isolated state. That per-pod isolation is the whole reason these manifests
use a StatefulSet.

## Deploy

1. **Build and push the image** from the monorepo root, then set `image:` in `miner-deployment.yaml`:
   ```sh
   docker build -f packages/gittensory-miner/Dockerfile -t <registry>/gittensory-miner:latest .
   docker push <registry>/gittensory-miner:latest
   ```
2. **Create the Secret** (fill in real values first — never commit the filled-in copy):
   ```sh
   cp k8s/miner-secret.example.yaml k8s/miner-secret.yaml   # edit in your real GITHUB_TOKEN + provider keys
   kubectl apply -f k8s/miner-secret.yaml
   ```
3. **Deploy the workers:**
   ```sh
   kubectl apply -f k8s/miner-deployment.yaml
   ```

## Scale

Each replica is one isolated worker with its own volume. Scale the fleet with:

```sh
kubectl scale statefulset/gittensory-miner --replicas=<N>
```

or by editing `replicas:` in `miner-deployment.yaml` and re-applying. New replicas each get a fresh
per-pod PVC from the `volumeClaimTemplate`; scaling down retains the PVCs (Kubernetes does not delete them
automatically), so a scaled-back worker resumes its own state when scaled up again.

## Notes

- **Secrets** are injected at runtime via the Secret — the image contains no credentials. `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` are marked `optional`, so a worker running only the providers you configure starts cleanly
  without the others.
- **Resources** default to a modest CLI-worker baseline (`250m`/`512Mi` request, `1`/`1Gi` limit) with headroom
  for a coding-agent subprocess. Tune for your providers and cluster.
- **Storage** uses the cluster's default StorageClass at `2Gi` per pod; set `storageClassName` in the
  `volumeClaimTemplate` if you need a specific class.
