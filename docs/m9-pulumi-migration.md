> **HISTORICAL—DO NOT RUN.** This document records the retired Mac-mini application stack. Current application operations use `home-server`.

# M9 Pulumi Migration Notes (www-jtp0.9.6)

**Status: REQUIRES CALUM - do NOT apply without explicit approval.**

Renaming the Pulumi project/config identity can orphan production state if
applied without first running previews and confirming no unintended replacements.
This document prepares the changes and migration steps; Calum applies.

## What needs renaming

Three separate Pulumi projects live under `infra/`:

| File | Current `name` | Target `name` |
|---|---|---|
| `infra/Pulumi.yaml` | `control-center` | `world-wide-webb` |
| `infra/cloudflare/Pulumi.yaml` | `control-center-cloudflare` | `world-wide-webb-cloudflare` |
| `infra/unifi/Pulumi.yaml` | `control-center-unifi` | `world-wide-webb-unifi` |

The main project's config namespace is read as `new pulumi.Config("ccinfra")` in
`infra/program.ts` (line 22). The stack config file `infra/Pulumi.prod.yaml` keys
are therefore all `ccinfra:*`.

CI (`ci.yml` lines 245, 923-935) writes:
```
pulumi config set ccinfra:kubeContext
pulumi config set --path "ccinfra:imageDigests.$svc"
```
and reads:
```ruby
data.fetch("config")["ccinfra:imageDigests"]
```

The config namespace (`ccinfra`) is **independent of the Pulumi project `name`**.
Pulumi project `name` identifies the project in Pulumi Cloud; config namespace is
what `new pulumi.Config("<namespace>")` reads from the stack config file. They
happen to share the same string today but are decoupled.

## Risk classification

| Change | Risk | Notes |
|---|---|---|
| `Pulumi.yaml name: control-center` → `name: world-wide-webb` | **HIGH** | Renames the project in Pulumi Cloud. Pulumi uses the project name as part of the stack URN (`organization/project/stack`). Renaming breaks all existing state references. Requires `pulumi stack rename` on the Pulumi Cloud side, OR a state migration with `pulumi state rename`. |
| `Pulumi.prod.yaml ccinfra:*` → `wwwinfra:*` | **HIGH** | All existing stack config keys are namespaced. Changing the namespace means all keys become unrecognised until the program is updated AND the state is re-keyed. |
| Updating `infra/program.ts` `new pulumi.Config("ccinfra")` → `new pulumi.Config("wwwinfra")` | MEDIUM | If applied before stack config is re-keyed, all config reads return empty/nil, which may cause deployments to delete or reset resources. |
| Updating CI `ccinfra:imageDigests` references | MEDIUM | If CI writes `wwwinfra:imageDigests` but the program still reads `ccinfra:imageDigests`, digest pins silently stop working and Pulumi uses `latest` tags. The CLAUDE.md "silently never roll" anti-pattern. |
| `infra/cloudflare/Pulumi.yaml` and `infra/unifi/Pulumi.yaml` renames | LOW-MEDIUM | Cloudflare and UniFi programs use separate stacks with no `imageDigests`; risk is limited to Pulumi Cloud project rename URN breakage. |

## Safe migration procedure

**Pre-condition:** www-jtp0.9.5 (image name CI rename) must be merged and
deployed, so the new image names are live and have digest pins before the
Pulumi config is touched.

### Step 1 - Run previews with the current identity (baseline)

```bash
cd infra
pulumi preview --stack prod  # Must show 0 replacements
cd cloudflare
pulumi preview --stack prod
cd ../unifi
pulumi preview --stack prod
```

### Step 2 - Rename Pulumi Cloud projects

This is done in Pulumi Cloud UI or via the Pulumi Cloud API:

- Rename `control-center` → `world-wide-webb` under the account
- Rename `control-center-cloudflare` → `world-wide-webb-cloudflare`
- Rename `control-center-unifi` → `world-wide-webb-unifi`

Then update the local stack references:

```bash
# In infra/
pulumi stack select organization/world-wide-webb/prod
```

**STOP - run `pulumi preview --stack prod` again. It MUST show 0 replacements.**
If you see resource replacements, stop and investigate before applying.

### Step 3 - Update Pulumi.yaml project names (code change)

Only after step 2 succeeds:
- `infra/Pulumi.yaml`: `name: world-wide-webb`
- `infra/cloudflare/Pulumi.yaml`: `name: world-wide-webb-cloudflare`
- `infra/unifi/Pulumi.yaml`: `name: world-wide-webb-unifi`

### Step 4 - Rename the config namespace (ATOMIC with CI change)

If renaming `ccinfra:` → `wwwinfra:` (optional, the namespace is decoupled from
the project name and can remain `ccinfra` indefinitely):

1. Copy all existing stack config keys to the new namespace:
   ```bash
   # Example - do for each key in Pulumi.prod.yaml:
   pulumi config set wwwinfra:kubeContext cc-homelab --stack prod
   pulumi config set wwwinfra:cloudflaredReplicas 2 --stack prod
   # ... etc
   ```
2. Update `infra/program.ts` line 22:
   ```ts
   const cfg = new pulumi.Config("wwwinfra");
   ```
3. Update CI `ci.yml` all `ccinfra:imageDigests` references to `wwwinfra:imageDigests`.
4. Update description comments in `infra/src/services.ts`, `infra/src/cluster.ts`.
5. Run `pulumi preview --stack prod` - **must show 0 replacements** before applying.
6. Remove old `ccinfra:*` keys after a successful apply:
   ```bash
   pulumi config rm ccinfra:imageDigests --stack prod
   # etc.
   ```

**Conservative recommendation:** Keep the namespace as `ccinfra` for now.
Renaming it adds risk with zero functional benefit - the Pulumi project name
and the config namespace are independent identifiers. The audit allowlist
already marks `ccinfra:` as `allowed-compatibility-alias`.

### Step 5 - Update descriptions

Once steps 1-3 are done, update the human-readable descriptions in each
`Pulumi.yaml` to reference `world-wide-webb`.

## Rollback

If the project rename causes issues, rename back in Pulumi Cloud UI. The stack
config and code are unchanged until step 3, so rollback is a single UI action.

## Files to change (code only, no apply)

```
infra/Pulumi.yaml                     name: world-wide-webb
infra/cloudflare/Pulumi.yaml          name: world-wide-webb-cloudflare
infra/unifi/Pulumi.yaml               name: world-wide-webb-unifi
```

The config namespace (`ccinfra:`) is intentionally left unchanged (see
conservative recommendation above). If Calum decides to rename it, the steps
above apply.
