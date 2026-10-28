// Managed draft transactions. Never sends to the provider or touches its composer.
export class PendingDraftHistory {
  constructor() { this.value = ''; this.stages = []; }

  observe(next) {
    if (typeof next !== 'string' || next === this.value) return;
    const old = this.value;
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let oldEnd = old.length, nextEnd = next.length;
    while (oldEnd > start && nextEnd > start && old[oldEnd - 1] === next[nextEnd - 1]) {
      oldEnd--; nextEnd--;
    }
    const delta = (nextEnd - start) - (oldEnd - start);
    for (const stage of this.stages) {
      if (oldEnd <= stage.start) stage.start += delta;
      else if (start < stage.start + stage.text.length) stage.valid = false;
    }
    this.value = next;
  }

  stage(current, draft) {
    this.observe(current);
    if (typeof draft !== 'string' || !draft) throw new Error('empty staged draft');
    const text = (this.value ? '\n' : '') + draft;
    this.stages.push({ start: this.value.length, text, valid: true });
    this.value += text;
    return this.value;
  }

  get canUndo() { return this.stages.length > 0; }

  undo(current) {
    this.observe(current);
    const stage = this.stages.at(-1);
    if (!stage) return { value: this.value, undone: false, reason: 'Nothing staged to undo.' };
    if (!stage.valid || this.value.slice(stage.start, stage.start + stage.text.length) !== stage.text) {
      return { value: this.value, undone: false,
        reason: 'Staged text was edited; automatic Undo would risk removing your changes. Edit the pending draft manually.' };
    }
    this.value = this.value.slice(0, stage.start) + this.value.slice(stage.start + stage.text.length);
    this.stages.pop();
    return { value: this.value, undone: true };
  }

  clear() { this.value = ''; this.stages = []; }
}
