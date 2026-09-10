const messagesElement = document.querySelector("#messages");
const form = document.querySelector("#composer");
const input = document.querySelector("#message-input");
const submitButton = form.querySelector("button");

let sending = false;

await loadMessages();
resizeInput();
input.focus();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || sending) return;

  sending = true;
  submitButton.disabled = true;
  removeError();
  const userMessage = appendMessage({ role: "user", text });
  input.value = "";
  resizeInput();
  const pending = appendPending();
  scrollToLatest();

  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error("今は応答できません。少し待ってから、もう一度お試しください。");

    pending.remove();
    appendMessage(body.message);
  } catch (error) {
    pending.remove();
    userMessage.remove();
    input.value = text;
    resizeInput();
    showError(error.message);
  } finally {
    sending = false;
    submitButton.disabled = false;
    input.focus();
    scrollToLatest();
  }
});

input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

async function loadMessages() {
  try {
    const response = await fetch("/api/messages");
    if (!response.ok) throw new Error();
    const { messages } = await response.json();

    messages.forEach(appendMessage);
    scrollToLatest(false);
  } catch {
    showError("以前の会話を読み込めませんでした。もう一度お試しください。");
  }
}

function appendMessage(message) {
  const article = document.createElement("article");
  const paragraph = document.createElement("p");
  article.className = `message ${message.role}`;
  paragraph.textContent = message.text;
  article.append(paragraph);
  messagesElement.append(article);
  return article;
}

function appendPending() {
  const article = document.createElement("article");
  article.className = "message assistant pending";
  article.setAttribute("aria-label", "考えています");
  article.innerHTML = '<span class="thinking"><span></span><span></span><span></span></span>';
  messagesElement.append(article);
  return article;
}

function showError(text) {
  const error = document.createElement("p");
  error.className = "error-banner";
  error.setAttribute("role", "alert");
  error.textContent = text;
  messagesElement.append(error);
}

function removeError() {
  messagesElement.querySelector(".error-banner")?.remove();
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function scrollToLatest(smooth = true) {
  requestAnimationFrame(() => {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  });
}
