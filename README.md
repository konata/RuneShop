# RuneShop

![RuneShop](assets/art.jpg)

Use Codex from any of your own trusted machines.

## Deploy

Install [Bun](https://bun.sh/), then clone and start RuneShop as the user who
owns the checkout:

```sh
git clone https://github.com/konata/RuneShop.git
cd RuneShop
bun install
bun run start
```

Do not use `sudo` for this step unless the checkout is owned by root.
RuneShop listens on `0.0.0.0:3721` during setup. To choose another port:

```sh
bun run start --port <PORT>
```

Open the Setup URL printed by RuneShop. It includes the one-time token; replace
the hostname if necessary, then choose an admin pass and upload the `auth.json`
created by Codex sign-in. Configuration and credentials are stored in
`~/.runeshop`, and the Admin page becomes available immediately.

### systemd

On Linux with systemd, complete Bootstrap before installing the service:

- When RuneShop runs as a regular user with sudo access, run the exact sudo
  command shown on the Bootstrap page.
- When both RuneShop and its checkout belong to root, click **Install
  systemd service**.

Root installs the system-wide unit, but the service continues to run as the
user who completed Bootstrap. It starts at boot, restarts after failures, and
supports updates from the Admin page.

Without systemd, RuneShop stays attached to the current terminal and managed
updates are unavailable. Start it again with `bun run start` after the process
stops or the machine reboots.

Open `http://<HOST>:<PORT>/admin` after setup.

## Codex

Add this provider to `~/.codex/config.toml`:

```toml
model = "gpt-5.6-sol"
model_provider = "runeshop"

[model_providers.runeshop]
name = "RuneShop"
base_url = "http://<HOST>:<PORT>/v1"
wire_api = "responses"
env_key = "PWD"
supports_websockets = false
```

## OpenCode

Add this provider to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "runeshop/gpt-5.6-sol",
  "provider": {
    "runeshop": {
      "npm": "@ai-sdk/openai",
      "name": "RuneShop",
      "options": {
        "baseURL": "http://<HOST>:<PORT>/v1",
        "apiKey": "{env:PWD}"
      },
      "models": {
        "gpt-5.6-sol": { "name": "GPT-5.6 Sol" }
      }
    }
  }
}
```

## Pi

Add an `openai-responses` provider to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "runeshop": {
      "baseUrl": "http://<HOST>:<PORT>/v1",
      "api": "openai-responses",
      "apiKey": "$PWD",
      "authHeader": true,
      "compat": { "supportsDeveloperRole": false },
      "models": [{ "id": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "reasoning": true }]
    }
  }
}
```

The Pi API key is a local client identifier, not an upstream credential.

Use RuneShop only for your own devices and trusted automation. Treat the
Codex credential like a password, and follow OpenAI's
[Terms of Use](https://openai.com/policies/row-terms-of-use/) and
[Account Sharing Policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy).
