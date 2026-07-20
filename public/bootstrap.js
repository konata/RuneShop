const byId = (id) => document.getElementById(id)
const form = byId("bootstrap-form")
const token = byId("bootstrap-token")
const button = byId("setup-button")
const setupError = byId("setup-error")
const service = byId("install-service")
const serviceError = byId("service-error")
const file = byId("auth-file")
const deviceStart = byId("device-start")
const devicePanel = byId("device-panel")
const deviceUrl = byId("device-url")
const deviceCode = byId("device-code")
const deviceStatus = byId("device-status")
const deviceError = byId("device-error")
const storageKey = "runeshop-setup-token"
const fragmentToken = new URLSearchParams(location.hash.slice(1)).get("token")?.trim() || ""
let bootstrapToken = fragmentToken || sessionStorage.getItem(storageKey) || ""
if (fragmentToken) {
  sessionStorage.setItem(storageKey, fragmentToken)
  history.replaceState(null, "", `${location.pathname}${location.search}`)
}

function failure(node, cause) {
  node.textContent = cause.message
  node.hidden = false
}

async function decode(response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error?.message || `${response.status} ${response.statusText}`)
  return body
}

async function waitForAdmin() {
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    try {
      const response = await fetch("/admin/login", { cache: "no-store" })
      if (response.ok && new URL(response.url).pathname === "/admin/login") return location.replace("/admin/login")
    } catch {}
  }
}

function complete(managed, systemd, manualSystemd, manualSystemdCommand) {
  const needsToken = systemd && !bootstrapToken
  byId("setup-state").classList.add("ready")
  byId("setup-label").textContent = "Ready"
  byId("hero-title").textContent = "Ready"
  byId("hero-copy").innerHTML = "<li>Configuration saved</li><li>RuneShop is ready</li><li>Open the admin console</li>"
  byId("bootstrap-title").textContent = "Setup complete"
  byId("bootstrap-copy").hidden = false
  byId("bootstrap-copy").textContent = needsToken
    ? "Enter the setup token again to install the systemd service."
    : managed ? "RuneShop is restarting under systemd." : systemd || manualSystemd ? "RuneShop is ready. Service installation is optional." : "RuneShop is ready."
  service.hidden = !systemd || managed
  byId("manual-action").hidden = !manualSystemd || managed
  if (manualSystemd) {
    byId("manual-action-copy").textContent = "Install and start the systemd service manually:"
    byId("manual-action-command").textContent = manualSystemdCommand
  }
  byId("setup-steps").hidden = true
  byId("token-field").hidden = !needsToken
  byId("setup-panel").hidden = true
  byId("complete-panel").hidden = false
  byId("open-admin").hidden = false
  if (!systemd && !manualSystemd) sessionStorage.removeItem(storageKey)
  if (managed || !systemd && !manualSystemd) void waitForAdmin()
}

file.addEventListener("change", () => {
  byId("file-name").textContent = file.files[0]?.name || "Choose auth.json"
})

let deviceTimer

function deviceFailure(cause) {
  failure(deviceError, cause)
  deviceStart.disabled = false
  deviceStart.textContent = "Sign in with device code"
}

async function pollDevice() {
  clearTimeout(deviceTimer)
  let status
  try {
    const response = await fetch("/bootstrap/api/device", { cache: "no-store", headers: { "x-runeshop-bootstrap": bootstrapToken } })
    status = await decode(response)
  } catch (cause) {
    deviceFailure(cause)
    return
  }
  if (status.state === "pending") {
    deviceTimer = setTimeout(pollDevice, 2500)
    return
  }
  if (status.state === "failed") {
    deviceFailure(new Error(status.error || "device sign-in failed"))
    return
  }
  if (status.state === "complete") {
    const email = status.account?.email
    deviceStatus.textContent = email ? `Signed in as ${email}. Credential saved.` : "Signed in. Credential saved."
    deviceStart.disabled = true
    deviceStart.textContent = "Signed in"
    file.required = false
    file.disabled = true
    byId("file-name").textContent = "Signed in with device code"
  }
}

deviceStart.addEventListener("click", async () => {
  bootstrapToken = token.value || bootstrapToken
  if (!bootstrapToken) return deviceFailure(new Error("setup token is required"))
  sessionStorage.setItem(storageKey, bootstrapToken)
  deviceError.hidden = true
  deviceStart.disabled = true
  deviceStart.textContent = "Requesting code…"
  try {
    const body = await decode(await fetch("/bootstrap/api/device", {
      method: "POST",
      cache: "no-store",
      headers: { "x-runeshop-bootstrap": bootstrapToken }
    }))
    deviceUrl.textContent = body.verification_url
    deviceUrl.href = body.verification_url
    deviceCode.textContent = body.user_code
    deviceStatus.textContent = "Waiting for authorization…"
    devicePanel.hidden = false
    deviceStart.textContent = "Waiting for sign-in…"
    void pollDevice()
  } catch (cause) {
    deviceFailure(cause)
  }
})

form.addEventListener("submit", async (event) => {
  event.preventDefault()
  setupError.hidden = true
  bootstrapToken = token.value
  sessionStorage.setItem(storageKey, bootstrapToken)
  button.disabled = true
  button.textContent = "Saving…"
  try {
    const data = new FormData(form)
    if (!file.files.length) data.delete("auth")
    const body = await decode(await fetch("/bootstrap/api/setup", {
      method: "POST",
      cache: "no-store",
      headers: { "x-runeshop-bootstrap": bootstrapToken },
      body: data
    }))
    complete(body.managed, body.systemd, body.manual_systemd, body.manual_systemd_command)
  } catch (cause) {
    failure(setupError, cause)
    button.disabled = false
    button.textContent = "Save configuration"
  }
})

service.addEventListener("click", async () => {
  bootstrapToken = token.value || bootstrapToken
  if (!bootstrapToken) return failure(serviceError, new Error("setup token is required"))
  sessionStorage.setItem(storageKey, bootstrapToken)
  service.disabled = true
  service.textContent = "Installing…"
  serviceError.hidden = true
  try {
    await decode(await fetch("/bootstrap/api/service", {
      method: "POST",
      cache: "no-store",
      headers: { "x-runeshop-bootstrap": bootstrapToken }
    }))
    sessionStorage.removeItem(storageKey)
    service.textContent = "Starting RuneShop…"
    byId("restart-copy").hidden = false
    byId("restart-copy").textContent = "This page will continue when the service is ready."
    void waitForAdmin()
  } catch (cause) {
    failure(serviceError, cause)
    service.disabled = false
    service.textContent = "Install systemd service"
  }
})

token.value = bootstrapToken
byId("endpoint").textContent = location.host
void fetch("/bootstrap/api/status", { cache: "no-store" })
  .then(decode)
  .then((status) => status.configured && complete(status.managed, status.systemd, status.manual_systemd, status.manual_systemd_command))
  .catch(() => undefined)
