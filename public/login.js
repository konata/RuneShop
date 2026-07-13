const form = document.getElementById("login-form")
const password = document.getElementById("password")
const button = document.getElementById("login-button")
const error = document.getElementById("login-error")

form.addEventListener("submit", async (event) => {
  event.preventDefault()
  button.disabled = true
  button.textContent = "Signing in…"
  error.hidden = true
  try {
    const response = await fetch("/admin/api/session", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: password.value })
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error?.message || "Sign in failed")
    location.replace("/admin")
  } catch (cause) {
    error.textContent = cause.message
    error.hidden = false
    password.select()
    button.disabled = false
    button.textContent = "Sign in"
  }
})
