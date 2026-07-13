const byId = (id) => document.getElementById(id)
const form = byId("bootstrap-form")
const token = byId("bootstrap-token")
const button = byId("setup-button")
const error = byId("setup-error")
const service = byId("install-service")
const serviceError = byId("service-error")
const file = byId("auth-file")
const storageKey = "runeshop-setup-token"
let bootstrapToken = sessionStorage.getItem(storageKey) || ""

function failure(node, cause) {
  node.textContent = cause.message
  node.hidden = false
}

async function response(request) {
  const body = await request.json().catch(() => ({}))
  if (!request.ok) throw new Error(body.error?.message || `${request.status} ${request.statusText}`)
  return body
}

async function waitForAdmin() {
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    try {
      const request = await fetch("/admin/login", { cache: "no-store" })
      if (request.ok && new URL(request.url).pathname === "/admin/login") return location.replace("/admin/login")
    } catch {}
  }
}

function complete(managed, systemd, manualSystemd, manualSystemdCommand) {
  const needsToken = systemd && !bootstrapToken
  byId("setup-state").classList.add("ready")
  byId("setup-label").textContent = "Ready"
  byId("hero-title").textContent = "Ready"
  byId("hero-copy").innerHTML = "<li>Configuration saved</li><li>Restart RuneShop</li><li>Open the admin console</li>"
  byId("bootstrap-title").textContent = "Setup complete"
  byId("bootstrap-copy").hidden = false
  byId("bootstrap-copy").textContent = needsToken
    ? "Enter the setup token again to install the systemd service."
    : managed ? "RuneShop is restarting under systemd." : "RuneShop is ready after restart."
  service.hidden = !systemd
  byId("manual-action").hidden = systemd || managed
  if (manualSystemd) {
    byId("manual-action-copy").textContent = "Install and start the systemd service manually:"
    byId("manual-action-command").textContent = manualSystemdCommand
  }
  byId("setup-steps").hidden = true
  byId("token-field").hidden = !needsToken
  byId("setup-panel").hidden = true
  byId("complete-panel").hidden = false
  if (!systemd) sessionStorage.removeItem(storageKey)
  void waitForAdmin()
}

file.addEventListener("change", () => {
  byId("file-name").textContent = file.files[0]?.name || "Choose auth.json"
})

form.addEventListener("submit", async (event) => {
  event.preventDefault()
  error.hidden = true
  bootstrapToken = token.value
  sessionStorage.setItem(storageKey, bootstrapToken)
  button.disabled = true
  button.textContent = "Saving…"
  try {
    const body = await response(await fetch("/bootstrap/api/setup", {
      method: "POST",
      cache: "no-store",
      headers: { "x-runeshop-bootstrap": bootstrapToken },
      body: new FormData(form)
    }))
    complete(body.managed, body.systemd, body.manual_systemd, body.manual_systemd_command)
  } catch (cause) {
    failure(error, cause)
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
    await response(await fetch("/bootstrap/api/service", {
      method: "POST",
      cache: "no-store",
      headers: { "x-runeshop-bootstrap": bootstrapToken }
    }))
    sessionStorage.removeItem(storageKey)
    service.textContent = "Starting RuneShop…"
    byId("restart-copy").hidden = false
    byId("restart-copy").textContent = "This page will continue when the service is ready."
  } catch (cause) {
    failure(serviceError, cause)
    service.disabled = false
    service.textContent = "Install systemd service"
  }
})

token.value = bootstrapToken
byId("endpoint").textContent = location.host
void fetch("/bootstrap/api/status", { cache: "no-store" })
  .then(response)
  .then((status) => status.configured && complete(status.managed, status.systemd, status.manual_systemd, status.manual_systemd_command))
  .catch(() => undefined)
