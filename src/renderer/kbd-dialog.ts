import type { KbdInteractiveRequest } from '@shared/types'

export interface KbdDialog {
  /**
   * Show the challenge and resolve with one answer per prompt, or null if the
   * user cancels.
   */
  prompt: (request: KbdInteractiveRequest) => Promise<string[] | null>
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element #${id}`)
  return node as T
}

/**
 * App-level singleton modal for keyboard-interactive (MFA/OTP) challenges.
 * Builds one input per prompt, masking those whose echo flag is false.
 */
export function setupKbdDialog(): KbdDialog {
  const view = el<HTMLElement>('kbd-view')
  const form = el<HTMLFormElement>('kbd-form')
  const title = el<HTMLElement>('kbd-title')
  const instructions = el<HTMLElement>('kbd-instructions')
  const fields = el<HTMLElement>('kbd-fields')
  const cancelBtn = el<HTMLButtonElement>('kbd-cancel')

  let resolver: ((value: string[] | null) => void) | null = null
  let inputs: HTMLInputElement[] = []

  function close(value: string[] | null): void {
    view.classList.add('hidden')
    fields.replaceChildren()
    inputs = []
    const r = resolver
    resolver = null
    r?.(value)
  }

  cancelBtn.addEventListener('click', () => close(null))
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    close(inputs.map((i) => i.value))
  })

  return {
    prompt: (request) =>
      new Promise<string[] | null>((resolve) => {
        resolver = resolve
        title.textContent = request.name?.trim() || 'Authentication required'
        instructions.textContent = request.instructions?.trim() || ''
        instructions.classList.toggle('hidden', !instructions.textContent)

        fields.replaceChildren()
        inputs = request.prompts.map((p) => {
          const label = document.createElement('label')
          // textContent (not innerHTML) — server-provided prompt text is data.
          label.append(document.createTextNode(p.prompt))
          const input = document.createElement('input')
          input.type = p.echo ? 'text' : 'password'
          input.autocomplete = 'off'
          label.appendChild(input)
          fields.appendChild(label)
          return input
        })

        view.classList.remove('hidden')
        inputs[0]?.focus()
      })
  }
}
