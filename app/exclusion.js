/* Exclusion engine — pure, no I/O, no DOM.
 *
 * Rule: picking a destination in a *fork* slot consumes it. Any later fork slot
 * offering the same destination shows it as already done. Detail slots (which
 * afternoon stop, how to get to the airport) never consume anything — otherwise
 * choosing the Okutama day trip would grey out its own afternoon.
 *
 * "Later" is (dayOrder, order). The Rain plan sorts last, so it inherits
 * "already done" from days 1-4 without imposing anything back on them.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Exclusion = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /** Sort key for a slot. Lower comes first. */
  function position(slot) {
    return [slot.dayOrder != null ? slot.dayOrder : 99, slot.order != null ? slot.order : 0];
  }

  function isBefore(a, b) {
    const pa = position(a), pb = position(b);
    return pa[0] !== pb[0] ? pa[0] < pb[0] : pa[1] < pb[1];
  }

  /** Look up the option a slot currently has picked, falling back to its default. */
  function pickedOption(slot, choices) {
    const chosenId = choices && choices[slot.id] && choices[slot.id].option;
    if (chosenId) {
      const hit = slot.options.find(o => o.id === chosenId);
      if (hit) return hit;
      // Stored choice points at an option that no longer exists (data changed
      // under us). Fall through to the default rather than render a broken slot.
    }
    return slot.options.find(o => o.default) || null;
  }

  /**
   * Which destination groups are used up, and by whom.
   * @returns {Object} group -> { slot, option }
   */
  function consumedGroups(slots, choices) {
    const consumed = {};
    for (const slot of slots) {
      if (slot.scope !== 'fork') continue;
      const opt = pickedOption(slot, choices);
      if (!opt || !opt.group) continue;

      const groups = [opt.group].concat(opt.alsoConsumes || []);
      for (const g of groups) {
        // Earliest consumer wins, so the label reads "Done on Day 2", not Day 4.
        if (!consumed[g] || isBefore(slot, consumed[g].slot)) {
          consumed[g] = { slot, option: opt };
        }
      }
    }
    return consumed;
  }

  /**
   * Is this option already used up by an *earlier* slot?
   * @returns {null | { slot, option }} the earlier pick that consumed it
   */
  function consumedBy(option, slot, consumed) {
    if (!option.group) return null;              // travel modes never participate
    // Exclusion is strictly between whole-day forks. A detail slot is a sub-choice
    // inside a day you already committed to, so it is neither a consumer nor a
    // target: the Okutama fork must not grey out the Okutama afternoon.
    if (slot.scope !== 'fork') return null;
    const hit = consumed[option.group];
    if (!hit) return null;
    if (hit.slot.id === slot.id) return null;    // a slot never consumes itself
    if (!isBefore(hit.slot, slot)) return null;  // consumed later: still available
    return hit;
  }

  /**
   * Decorate every slot with what the UI needs to render.
   * Never mutates its inputs.
   */
  function resolve(slots, choices) {
    const ordered = slots.slice().sort((a, b) => (isBefore(a, b) ? -1 : isBefore(b, a) ? 1 : 0));
    const consumed = consumedGroups(ordered, choices);

    return ordered.map(slot => {
      const picked = pickedOption(slot, choices);
      return Object.assign({}, slot, {
        picked: picked ? picked.id : null,
        pickedBy: (choices && choices[slot.id] && choices[slot.id].by) || null,
        options: slot.options.map(o => {
          const by = consumedBy(o, slot, consumed);
          return Object.assign({}, o, {
            isPicked: !!picked && o.id === picked.id,
            doneBy: by ? { slotId: by.slot.id, day: by.slot.day, optionId: by.option.id } : null,
          });
        }),
      });
    });
  }

  return { resolve, consumedGroups, consumedBy, pickedOption, isBefore, position };
});
