let editor;
let styles;

function loadStyles() {
  if (!styles) {
    styles = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/static/company-editor.css?v=company-editor-20261007";
      link.onload = resolve;
      link.onerror = () => {
        link.remove();
        styles = null;
        reject(new Error("Could not load company editor styles"));
      };
      document.head.append(link);
    });
  }
  return styles;
}

async function request(path, options = {}) {
  // Always use the server: company administration never uses guest fixtures.
  const response = await fetch(`/api/admin/companies${path}`, {
    ...options,
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" ? payload.detail
      : Array.isArray(payload?.detail) ? [...new Set(payload.detail.map(item => item.msg).filter(Boolean))].join(". ") : null;
    const error = new Error(detail || `Could not update companies (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function createEditor() {
  const dialog = document.createElement("dialog");
  dialog.className = "company-editor";
  dialog.setAttribute("aria-labelledby", "company-editor-title");
  dialog.innerHTML = `
    <header class="company-editor-header">
      <div><h2 id="company-editor-title">Manage companies</h2><p>Changes sync to xjobscore and Discover on the next publication.</p></div>
      <button type="button" data-company-close aria-label="Close company editor">Close</button>
    </header>
    <form class="company-editor-search" role="search" aria-label="Search companies">
      <label for="company-editor-query">Find a company</label>
      <div><input id="company-editor-query" name="q" type="search" placeholder="Name, domain, or company ID" maxlength="500" autocomplete="off"><button type="submit">Search</button></div>
    </form>
    <p class="company-editor-status" role="status" aria-live="polite"></p>
    <div class="company-editor-body">
      <section class="company-editor-results" aria-label="Companies">
        <div class="company-editor-table-wrap"><table><thead><tr><th scope="col">Company</th><th scope="col">Domain</th><th scope="col"><span class="company-editor-sr">Action</span></th></tr></thead><tbody></tbody></table></div>
        <p class="company-editor-empty" hidden>No matching companies.</p>
        <nav class="company-editor-pager" aria-label="Company pages"><button type="button" data-company-prev>Previous</button><span></span><button type="button" data-company-next>Next</button></nav>
      </section>
      <section class="company-editor-details" aria-label="Edit company">
        <p class="company-editor-prompt">Select a company to edit its details.</p>
        <form class="company-editor-form" hidden>
          <p class="company-editor-record"></p>
          <fieldset>
            <label for="company-editor-name">Name</label><input id="company-editor-name" name="name" required maxlength="500" autocomplete="off">
            <label for="company-editor-domain">Domain</label><input id="company-editor-domain" name="domain" maxlength="253" placeholder="company.com" autocomplete="off">
            <label for="company-editor-description">Description</label><textarea id="company-editor-description" name="description" rows="3" maxlength="8000"></textarea>
            <label for="company-editor-tags">Tags (JSON)</label><textarea id="company-editor-tags" name="tags" rows="5" spellcheck="false" aria-describedby="company-editor-tags-help"></textarea>
            <p id="company-editor-tags-help" class="company-editor-help">Use a JSON object, such as {"startup": true}. Use {} to clear tags.</p>
            <div class="company-editor-actions"><button type="button" data-company-reset>Reset changes</button><button type="submit" class="company-editor-save">Save changes</button></div>
          </fieldset>
        </form>
      </section>
    </div>`;
  document.body.append(dialog);

  const search = dialog.querySelector(".company-editor-search");
  const query = search.elements.q;
  const form = dialog.querySelector(".company-editor-form");
  const fieldset = form.querySelector("fieldset");
  const tbody = dialog.querySelector("tbody");
  const status = dialog.querySelector(".company-editor-status");
  const prompt = dialog.querySelector(".company-editor-prompt");
  const previous = dialog.querySelector("[data-company-prev]");
  const next = dialog.querySelector("[data-company-next]");
  const save = form.querySelector("[type=submit]");
  const fields = ["name", "domain", "description", "tags"];
  const limit = 50;
  let companies = [], selected = null, baseline = "", q = "", offset = 0, total = 0;
  let busy = false;

  const values = () => Object.fromEntries(fields.map(field => [field, form.elements[field].value]));
  const dirty = () => selected !== null && JSON.stringify(values()) !== baseline;
  const discard = () => !dirty() || window.confirm("Discard unsaved company changes?");
  const message = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle("is-error", error);
  };
  const controls = () => {
    fieldset.disabled = busy;
    search.querySelector("button").disabled = busy;
    previous.disabled = busy || offset === 0;
    next.disabled = busy || offset + limit >= total;
    dialog.querySelector("[data-company-close]").disabled = busy;
    tbody.querySelectorAll("button").forEach(button => { button.disabled = busy; });
    save.disabled = busy || !dirty();
    dialog.setAttribute("aria-busy", String(busy));
  };

  function select(company) {
    selected = company;
    prompt.hidden = !!company;
    form.hidden = !company;
    if (company) {
      form.elements.name.value = company.name;
      form.elements.domain.value = company.domain || "";
      form.elements.description.value = company.description || "";
      form.elements.tags.value = JSON.stringify(company.tags || {}, null, 2);
      form.elements.tags.setCustomValidity("");
      form.elements.name.setCustomValidity("");
      baseline = JSON.stringify(values());
      dialog.querySelector(".company-editor-record").textContent = `Company #${company.id}${company.sync_pending ? " · Waiting to sync to xjobscore" : ""}`;
      if (company.sync_error) message(`Sync needs attention: ${company.sync_error}`, true);
    }
    tbody.querySelectorAll("tr").forEach(row => row.classList.toggle("is-selected", row.dataset.id === String(company?.id)));
    controls();
  }

  function renderRows() {
    tbody.replaceChildren();
    companies.forEach(company => {
      const row = document.createElement("tr");
      row.dataset.id = String(company.id);
      const name = document.createElement("td");
      const label = document.createElement("strong");
      label.textContent = company.name;
      const id = document.createElement("small");
      id.textContent = `#${company.id}${company.sync_pending ? " · Pending sync" : ""}`;
      name.append(label, id);
      const domain = document.createElement("td");
      domain.textContent = company.domain || "—";
      const action = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Edit";
      button.setAttribute("aria-label", `Edit ${company.name}`);
      button.addEventListener("click", () => {
        if (selected?.id === company.id || !discard()) return;
        message("");
        select(company);
        form.elements.name.focus();
      });
      action.append(button);
      row.append(name, domain, action);
      row.classList.toggle("is-selected", selected?.id === company.id);
      tbody.append(row);
    });
    dialog.querySelector(".company-editor-empty").hidden = companies.length > 0;
    dialog.querySelector(".company-editor-pager span").textContent = total
      ? `${offset + 1}–${Math.min(offset + limit, total)} of ${total.toLocaleString()}`
      : "0 companies";
    controls();
  }

  async function load(newQuery = q, newOffset = offset) {
    busy = true;
    controls();
    message("Loading companies…");
    try {
      const payload = await request(`?${new URLSearchParams({ q: newQuery, limit, offset: newOffset })}`);
      q = newQuery;
      offset = newOffset;
      total = payload.total;
      companies = payload.companies;
      select(null);
      renderRows();
      message("");
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        companies = [];
        total = 0;
        select(null);
        renderRows();
      }
      message(error.message, true);
    } finally {
      busy = false;
      controls();
    }
  }

  search.addEventListener("submit", event => {
    event.preventDefault();
    if (!busy && discard()) load(query.value.trim(), 0);
  });
  previous.addEventListener("click", () => { if (!busy && discard()) load(q, Math.max(0, offset - limit)); });
  next.addEventListener("click", () => { if (!busy && discard()) load(q, offset + limit); });
  form.addEventListener("input", () => {
    form.elements.tags.setCustomValidity("");
    form.elements.name.setCustomValidity("");
    controls();
  });
  form.querySelector("[data-company-reset]").addEventListener("click", () => {
    select(selected);
    message("");
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !selected) return;
    let tags;
    try {
      tags = JSON.parse(form.elements.tags.value);
      if (tags === null || typeof tags !== "object" || Array.isArray(tags)) throw new Error();
    } catch (_) {
      form.elements.tags.setCustomValidity("Tags must be a valid JSON object.");
      form.elements.tags.reportValidity();
      return;
    }
    const updated = {
      name: form.elements.name.value.trim(),
      domain: form.elements.domain.value.trim().toLowerCase() || null,
      description: form.elements.description.value.trim() || null,
      tags,
    };
    if (!updated.name) {
      form.elements.name.setCustomValidity("Company name is required.");
      form.elements.name.reportValidity();
      return;
    }
    const changes = Object.fromEntries(fields.filter(field => JSON.stringify(updated[field]) !== JSON.stringify(selected[field])).map(field => [field, updated[field]]));
    if (!Object.keys(changes).length) { message("No changes to save."); return; }
    busy = true;
    controls();
    message("Saving changes…");
    try {
      const company = await request(`/${encodeURIComponent(selected.id)}`, { method: "PATCH", body: JSON.stringify(changes) });
      companies = companies.map(row => row.id === company.id ? company : row);
      renderRows();
      select(company);
      message(`Saved changes to ${company.name}. Waiting for the next xjobscore publication.`);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        companies = [];
        total = 0;
        select(null);
        renderRows();
      }
      message(error.message, true);
    } finally {
      busy = false;
      controls();
    }
  });

  dialog.querySelector("[data-company-close]").addEventListener("click", () => { if (!busy && discard()) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (busy || !discard()) event.preventDefault(); });
  return {
    open() {
      if (dialog.open) return;
      dialog.showModal();
      load();
    },
  };
}

export async function openCompanyEditor() {
  await loadStyles();
  editor ||= createEditor();
  editor.open();
}
