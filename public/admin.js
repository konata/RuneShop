const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]))

let revision
let csrf
let authFile
let loading = false
let samples = {}

function updateText(value) {
  ui.update.querySelector("span").textContent = value
}

async function request(path, init) {
  const method = init?.method || "GET"
  const headers = new Headers(init?.headers)
  if (csrf && method !== "GET" && method !== "HEAD") headers.set("x-csrf-token", csrf)
  const response = await fetch(path, { cache: "no-store", ...init, headers })
  const body = await response.json().catch(() => ({}))
  if (response.status === 401) location.replace("/admin/login")
  if (!response.ok) throw new Error(body.error?.message || `${response.status} ${response.statusText}`)
  return body
}

function compact(value) {
  if (value === null || value === undefined) return "--"
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

function remaining(epoch) {
  if (!epoch) return "reset unavailable"
  const seconds = Math.max(0, epoch - Date.now() / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days) return `resets in ${days}d ${hours}h`
  if (hours) return `resets in ${hours}h ${minutes}m`
  return `resets in ${minutes}m`
}

function windowName(window, detailed = false) {
  const hours = window.window_seconds / 3600
  const amount = Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10
  const label = hours >= 24 ? Math.round(hours / 24) === 7 ? "Weekly" : `${Math.round(hours / 24)}-day` : `${amount}-hour`
  return detailed ? `${label} window` : label
}

function uptime(seconds) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

function status(snapshot) {
  ui.health.classList.remove("offline")
  ui.health.lastChild.textContent = "Online"
  ui.revision.textContent = `${snapshot.commit} · ${snapshot.platform}`
  ui["today-requests"].textContent = snapshot.today.requests.toLocaleString()
  ui["today-success"].textContent = `${snapshot.today.success_rate}%`
  ui["month-requests"].textContent = snapshot.month.requests.toLocaleString()
  ui["month-success"].textContent = `${snapshot.month.success_rate}%`
  ui.uptime.textContent = uptime(snapshot.uptime_seconds)
  activity(snapshot.activity)
}

function usage(account) {
  const windows = [account.primary, account.secondary]
    .filter((window) => Number.isFinite(window?.window_seconds) && window.window_seconds > 0 && Number.isFinite(window.used_percent))
    .sort((left, right) => left.window_seconds - right.window_seconds)
  const [primary, secondary] = windows
  const used = Math.max(0, Math.min(100, Number(primary?.used_percent) || 0))
  ui.plan.textContent = account.plan
  ui["primary-percent"].textContent = primary ? `${used}%` : "♾️"
  ui["primary-reset"].textContent = primary ? `${windowName(primary, true)} · ${remaining(primary.resets_at)}` : "No usage limit"
  ui["primary-progress"].setAttribute("aria-label", primary ? `${windowName(primary)} usage` : "Unlimited")
  ui["primary-progress"].setAttribute("aria-valuenow", String(used))
  ui["primary-progress"].querySelector("span").style.width = `${used}%`
  ui["secondary-label"].textContent = secondary ? windowName(secondary) : primary?.window_seconds >= 86400 ? "5-hour" : "Weekly"
  ui["secondary-percent"].textContent = secondary ? `${secondary.used_percent}%` : "♾️"
  ui.lifetime.textContent = compact(account.lifetime_tokens)
  ui.credits.textContent = String(account.reset_credits)
}

function credentials(status) {
  ui["credential-badge"].className = "badge"
  if (!status.configured) {
    ui["credential-badge"].textContent = "Missing"
    ui["credential-badge"].classList.add("warning")
    ui["credential-summary"].textContent = "No Codex credential configured"
    ui["credential-detail"].textContent = "Import the auth.json created by Codex sign-in."
    return
  }
  ui["credential-badge"].textContent = status.refreshable ? "Ready" : "Needs attention"
  if (!status.refreshable) ui["credential-badge"].classList.add("warning")
  ui["credential-summary"].textContent = status.refreshable ? "Credential is active and refreshable" : "Credential cannot refresh automatically"
  const updated = status.updated_at ? new Date(status.updated_at).toLocaleString() : "unknown"
  const expiry = status.expires_at ? new Date(status.expires_at).toLocaleString() : "unknown"
  ui["credential-detail"].textContent = `Updated ${updated} · expires ${expiry}`
}

function eventLabel(event) {
  if (event.detail) return event.detail
  if (!event.status) return "Connection failed"
  if (event.status >= 400) return `Upstream returned ${event.status}`
  return event.path.endsWith("compact") ? "Context compacted" : "Request completed"
}

function clientName(value) {
  const client = typeof value === "string" ? value.trim() : ""
  if (!client) return "unknown"
  return client.split(/[\\/]+/).filter(Boolean).at(-1) || client
}

function eventIcon(event) {
  const namespace = "http://www.w3.org/2000/svg"
  const icon = document.createElementNS(namespace, "svg")
  const tone = !event.status || event.status >= 500 ? "error" : event.status >= 400 ? "warning" : ""
  icon.classList.add("event-icon")
  if (tone) icon.classList.add(tone)
  icon.setAttribute("viewBox", "0 0 24 24")
  icon.setAttribute("aria-hidden", "true")

  const shape = (name, attributes) => {
    const node = document.createElementNS(namespace, name)
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
    icon.append(node)
  }

  if (tone === "warning") {
    shape("path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" })
    shape("path", { d: "M12 9v4" })
    shape("path", { d: "M12 17h.01" })
  } else {
    shape("circle", { cx: "12", cy: "12", r: "10" })
    if (tone === "error") {
      shape("path", { d: "m15 9-6 6" })
      shape("path", { d: "m9 9 6 6" })
    } else {
      shape("path", { d: "m9 12 2 2 4-4" })
    }
  }
  return icon
}

function activity(events) {
  ui.activity.replaceChildren()
  if (!events.length) {
    const empty = document.createElement("li")
    empty.className = "empty"
    empty.textContent = "Requests will appear here."
    ui.activity.append(empty)
    ui["activity-updated"].textContent = "No requests yet"
    return
  }

  for (const event of events) {
    const row = document.createElement("li")
    const label = document.createElement("span")
    const client = document.createElement("span")
    const model = document.createElement("span")
    const time = document.createElement("time")
    label.className = "event"
    const count = event.count > 1 ? ` × ${event.count}` : ""
    label.textContent = `${eventLabel(event)}${count}`
    label.title = label.textContent
    const clientId = typeof event.client === "string" && event.client.trim() ? event.client.trim() : "unknown"
    client.className = "client"
    client.textContent = clientName(clientId)
    client.title = clientId
    model.className = "model"
    const effort = event.effort ? `/${event.effort}` : ""
    model.textContent = `${event.model || "--"}${effort}${event.fast ? "-⚡️" : ""}`
    model.title = model.textContent
    time.dateTime = event.time
    time.textContent = new Date(event.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    row.append(eventIcon(event), label, client, model, time)
    ui.activity.append(row)
  }
  ui["activity-updated"].textContent = `Updated ${new Date(events[0].time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
}

function badge(text, tone = "") {
  ui["update-badge"].textContent = text
  ui["update-badge"].className = `badge ${tone}`
}

function update(status) {
  revision = status
  ui["update-revisions"].textContent = `${status.current} → ${status.remote}`
  ui.update.disabled = true

  if (status.error) {
    badge("Check failed", "error")
    ui["update-summary"].textContent = status.error
    updateText("Unavailable")
  } else if (status.dirty || status.ahead) {
    badge("Local changes", "warning")
    ui["update-summary"].textContent = status.dirty ? "Working tree is not clean" : `${status.ahead} local commit${status.ahead === 1 ? "" : "s"}`
    updateText("Resolve locally")
  } else if (!status.behind) {
    badge("Up to date")
    ui["update-summary"].textContent = "No remote updates"
    updateText("Up to date")
  } else if (!status.supported) {
    badge(`${status.behind} behind`, "warning")
    ui["update-summary"].textContent = "RuneShop is not managed by systemd"
    updateText("Unavailable")
  } else {
    badge(`${status.behind} behind`)
    ui["update-summary"].textContent = `${status.behind} commit${status.behind === 1 ? "" : "s"} ready`
    updateText("Update now")
    ui.update.disabled = false
  }
}

function showUpdate() {
  if (!revision?.available) return
  ui["dialog-copy"].textContent = `Update ${revision.current} to ${revision.remote} and restart RuneShop.`
  ui.commits.replaceChildren(...revision.commits.map((commit) => {
    const row = document.createElement("li")
    const hash = document.createElement("span")
    const subject = document.createElement("span")
    hash.className = "mono"
    hash.textContent = commit.hash
    subject.textContent = commit.subject
    row.append(hash, subject)
    return row
  }))
  ui["update-progress"].hidden = true
  ui["confirm-update"].disabled = false
  ui["cancel-update"].disabled = false
  ui["update-dialog"].showModal()
}

async function startUpdate() {
  const target = revision.remote
  ui["confirm-update"].disabled = true
  ui["cancel-update"].disabled = true
  ui["update-progress"].hidden = false
  ui["update-progress"].textContent = "Starting updater…"
  try {
    await request("/admin/api/update", {
      method: "POST",
      headers: { "content-type": "application/json", "x-runeshop-action": "update" },
      body: "{}"
    })
    ui["update-progress"].textContent = "Updating and restarting…"
    await reconnect(target)
  } catch (error) {
    ui["update-progress"].textContent = error.message
    ui["confirm-update"].disabled = false
    ui["cancel-update"].disabled = false
  }
}

async function reconnect(target) {
  await new Promise((resolve) => setTimeout(resolve, 1500))
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch("/admin/api/status", { cache: "no-store" })
      if (response.status === 401) return location.replace("/admin/login")
      if (response.ok && (await response.json()).commit === target) return location.reload()
    } catch {
      // The service briefly disappears while systemd replaces the process.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  ui["update-progress"].textContent = "Restart is taking longer than expected. Refresh this page shortly."
}

function confirmAuth() {
  const [file] = ui["auth-file"].files
  if (!file) return
  authFile = file
  ui["auth-filename"].textContent = `${file.name} · ${compact(file.size)}B`
  ui["auth-progress"].hidden = true
  ui["confirm-auth"].disabled = false
  ui["cancel-auth"].disabled = false
  ui["auth-dialog"].showModal()
}

async function importAuth() {
  if (!authFile) return
  ui["confirm-auth"].disabled = true
  ui["cancel-auth"].disabled = true
  ui["auth-progress"].hidden = false
  ui["auth-progress"].textContent = "Validating credential…"
  const form = new FormData()
  form.append("auth", authFile)
  try {
    credentials(await request("/admin/api/credentials", { method: "POST", body: form }))
    usage(await request("/admin/api/account?refresh=1"))
    ui["auth-dialog"].close()
    authFile = undefined
    ui["auth-file"].value = ""
    toast("Codex credential imported")
  } catch (error) {
    ui["auth-progress"].textContent = error.message
    ui["confirm-auth"].disabled = false
    ui["cancel-auth"].disabled = false
  }
}

async function logout() {
  ui.logout.disabled = true
  try {
    await request("/admin/api/session/logout", { method: "POST" })
  } finally {
    location.replace("/admin/login")
  }
}

function configs(required = false) {
  const key = required ? "RUNESHOP_API_KEY" : "PWD"
  return {
    codex: `model = "gpt-5.6-sol"
model_provider = "runeshop"

[model_providers.runeshop]
name = "RuneShop"
base_url = "${location.origin}/v1"
env_key = "${key}"
wire_api = "responses"
supports_websockets = false`,
    opencode: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "runeshop/gpt-5.6-sol",
      provider: {
        runeshop: {
          npm: "@ai-sdk/openai",
          name: "RuneShop",
          options: { baseURL: `${location.origin}/v1`, apiKey: `{env:${key}}` },
          models: { "gpt-5.6-sol": { name: "GPT-5.6 Sol" } }
        }
      }
    }, null, 2),
    pi: JSON.stringify({
      providers: {
        runeshop: {
          baseUrl: `${location.origin}/v1`,
          api: "openai-responses",
          apiKey: `$${key}`,
          authHeader: true,
          compat: { supportsDeveloperRole: false },
          models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true }]
        }
      }
    }, null, 2)
  }
}

function showConfigs(required = false) {
  samples = configs(required)
  for (const [provider, sample] of Object.entries(samples)) ui[`${provider}-config`].textContent = sample
}

async function copy(value, message) {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    const input = document.createElement("textarea")
    input.value = value
    document.body.append(input)
    input.select()
    document.execCommand("copy")
    input.remove()
  }
  toast(message)
}

function toast(message) {
  ui.toast.textContent = message
  ui.toast.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (ui.toast.hidden = true), 2500)
}

async function load() {
  if (loading) return
  loading = true
  const tasks = [
    request("/admin/api/status").then(status).catch(offline),
    request("/admin/api/account").then(usage).catch((error) => toast(`Account status: ${error.message}`)),
    request("/admin/api/update").then(update).catch((error) => update({
      current: "--", remote: "--", behind: 0, ahead: 0, dirty: false, supported: false, error: error.message
    })),
    request("/admin/api/credentials").then(credentials).catch((error) => toast(`Credential status: ${error.message}`)),
    request("/admin/api/access").then(({ required }) => showConfigs(required)).catch((error) => toast(`API access: ${error.message}`))
  ]
  try {
    await Promise.allSettled(tasks)
  } finally {
    loading = false
  }
}

function offline(error) {
  ui.health.classList.add("offline")
  ui.health.lastChild.textContent = "Offline"
  toast(error.message)
}

ui.update.addEventListener("click", showUpdate)
ui["confirm-update"].addEventListener("click", startUpdate)
const activityCard = ui.activity.closest(".activity-card")
ui["activity-title"].closest(".section-heading").addEventListener("dblclick", () => activityCard.classList.toggle("show-project"))
showConfigs()
for (const provider of Object.keys(samples)) {
  const name = provider === "codex" ? "Codex" : provider === "opencode" ? "OpenCode" : "Pi"
  ui[`copy-${provider}`].addEventListener("click", () => copy(samples[provider], `${name} configuration copied`))
}
ui["choose-auth"].addEventListener("click", () => ui["auth-file"].click())
ui["auth-file"].addEventListener("change", confirmAuth)
ui["confirm-auth"].addEventListener("click", importAuth)
ui["auth-dialog"].addEventListener("close", () => {
  authFile = undefined
  ui["auth-file"].value = ""
})
ui.logout.addEventListener("click", logout)

async function boot() {
  csrf = (await request("/admin/api/session")).csrf
  await load()
  setInterval(load, 60_000)
}

boot().catch(offline)
