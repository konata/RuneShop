const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]))
let csrf
let access = { required: false, tenants: [] }

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

function masked(key) {
  return `${key.slice(0, 8)}••••••••••••••••••${key.slice(-6)}`
}

function toast(message) {
  ui.toast.textContent = message
  ui.toast.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (ui.toast.hidden = true), 2500)
}

async function copy(key) {
  try { await navigator.clipboard.writeText(key) }
  catch {
    const input = document.createElement("textarea")
    input.value = key
    document.body.append(input)
    input.select()
    document.execCommand("copy")
    input.remove()
  }
  toast("API key copied")
}

function row(tenant) {
  const entry = document.createElement("div")
  const alias = document.createElement("div")
  const name = document.createElement("strong")
  const key = document.createElement("div")
  const value = document.createElement("code")
  const reveal = document.createElement("button")
  const copyButton = document.createElement("button")
  const enabled = document.createElement("div")
  const toggle = document.createElement("label")
  const checkbox = document.createElement("input")
  const track = document.createElement("span")
  const enabledLabel = document.createElement("span")

  entry.className = "tenant-row"
  entry.setAttribute("role", "row")
  alias.className = "tenant-alias"
  name.textContent = tenant.alias
  alias.append(name)

  key.className = "key-cell"
  value.className = "key-value mono"
  value.textContent = masked(tenant.key)
  reveal.className = "quiet-button key-action"
  reveal.type = "button"
  reveal.textContent = "Reveal"
  reveal.addEventListener("click", () => {
    const visible = reveal.textContent === "Hide"
    value.textContent = visible ? masked(tenant.key) : tenant.key
    reveal.textContent = visible ? "Reveal" : "Hide"
  })
  copyButton.className = "quiet-button key-action"
  copyButton.type = "button"
  copyButton.textContent = "Copy"
  copyButton.addEventListener("click", () => copy(tenant.key))
  key.append(value, reveal, copyButton)

  enabled.className = "enabled-cell"
  toggle.className = "switch"
  checkbox.type = "checkbox"
  checkbox.checked = tenant.enabled
  checkbox.setAttribute("aria-label", `Enable ${tenant.alias}`)
  checkbox.addEventListener("change", async () => {
    checkbox.disabled = true
    try {
      access = await request("/admin/api/access/tenants", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias: tenant.alias, enabled: checkbox.checked })
      })
      render()
      toast(`${tenant.alias} ${checkbox.checked ? "enabled" : "disabled"}`)
    } catch (error) {
      render()
      toast(error.message)
    }
  })
  toggle.append(checkbox, track)
  enabledLabel.className = "enabled-label"
  enabledLabel.textContent = tenant.enabled ? "Enabled" : "Disabled"
  enabled.append(toggle, enabledLabel)
  entry.append(alias, key, enabled)
  return entry
}

function render() {
  const enabled = access.tenants.filter((tenant) => tenant.enabled).length
  const mode = access.required ? "required" : "open"
  document.querySelector(`input[name="access-mode"][value="${mode}"]`).checked = true
  ui["mode-options"].disabled = false
  ui["access-status"].lastChild.textContent = access.required ? "Required" : "Open"
  ui["tenant-count"].textContent = `${access.tenants.length} ${access.tenants.length === 1 ? "tenant" : "tenants"} · ${enabled} enabled`
  ui["tenant-card"].hidden = !access.required
  ui.tenants.replaceChildren(...access.tenants.map(row))
}

for (const option of document.querySelectorAll('input[name="access-mode"]')) option.addEventListener("change", async () => {
  ui["mode-options"].disabled = true
  try {
    const required = option.value === "required"
    access = await request("/admin/api/access", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ required })
    })
    render()
    toast(`API access set to ${required ? "Required" : "Open"}`)
  } catch (error) {
    render()
    toast(error.message)
  }
})

ui["new-tenant"].addEventListener("click", () => {
  ui["tenant-form"].reset()
  ui["tenant-error"].hidden = true
  ui["tenant-dialog"].showModal()
  ui["tenant-alias"].focus()
})
ui["cancel-tenant"].addEventListener("click", () => ui["tenant-dialog"].close())
ui["tenant-form"].addEventListener("submit", async (event) => {
  event.preventDefault()
  const alias = ui["tenant-alias"].value.trim()
  const submit = ui["tenant-form"].querySelector('button[type="submit"]')
  submit.disabled = true
  ui["tenant-error"].hidden = true
  try {
    access = await request("/admin/api/access/tenants", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias })
    })
    ui["tenant-dialog"].close()
    render()
    toast(`${alias} created`)
  } catch (error) {
    ui["tenant-error"].textContent = error.message
    ui["tenant-error"].hidden = false
  } finally { submit.disabled = false }
})

async function boot() {
  csrf = (await request("/admin/api/session")).csrf
  access = await request("/admin/api/access")
  render()
}

boot().catch((error) => toast(error.message))
