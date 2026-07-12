import ModifierHelpers from "./modifiers.js";
import {migrateDataToSystem} from "./migration.js";

export default class ActorHelpers {
  static async updateActor(event, formData) {
    formData = foundry.utils.expandObject(formData);
    const ownedItems = this.actor.items;

    // as of Foundry v10, saving an editor only submits the single entry for that editor
    if (Object.keys(formData).length > 1) {
      if (this.object.type === "minion") {
        Object.keys(formData?.data?.skills).forEach((skill) => {
          if (!formData.data.skills[skill].groupskill && this.object.system.skills[skill].groupskill) {
            // this is a minion group with a group skill being removed - reduce the rank by one (since we added 1 when it was checked)
            formData.data.skills[skill].rank -= this.object.system.quantity.value;
          }
        });
      }
      if (this.object.type !== "homestead") {
        if (this.object.type !== "vehicle") {
          // Handle credits
          if (formData.data.stats?.credits?.value) {
            const rawCredits = formData.data.stats?.credits.value
              ?.toString()
              .match(/^(?!.*\.).*|.*\./)[0]
              .replace(/[^0-9]+/g, "");
            formData.data.stats.credits.value = parseInt(rawCredits, 10);
          }
        }
      }
      if (this.object.type === "minion") {
        // include the updated quantity of minions in the group in the update object so automation can access it
        formData.data.quantity.value = Math.min(formData.data.quantity.max, formData.data.quantity.max - Math.floor(formData.data.stats.wounds.value - 1) / formData.data.unit_wounds.value);
      }
    }
    // Handle the free-form attributes list
    const formAttrs = foundry.utils.expandObject(formData)?.data?.attributes || {};
    const attributes = Object.values(formAttrs).reduce((obj, v) => {
      let k = v["key"].trim();
      delete v["key"];
      obj[k] = v;
      return obj;
    }, {});

    // Remove attributes which are no longer used
    if (this.object.system?.attributes) {
      for (let k of Object.keys(this.object.system.attributes)) {
        if (!attributes.hasOwnProperty(k)) attributes[`-=${k}`] = null;
      }
    }

    // recombine attributes to formData
    formData.data.attributes = attributes;

    // Update the Actor
    foundry.utils.setProperty(formData, `flags.starwarsffg.loaded`, false);

    // as of v12, "data" is no longer shimmed into "system" for you, so we must do it ourselves
    formData = migrateDataToSystem(formData);

    const curXP = this.object?.system?.experience?.available ? this.object.system.experience.available : 0;
    const newXP = formData?.system?.experience?.available ? formData.system.experience.available : 0;
    if (curXP !== newXP && curXP !== 0 && newXP !== 0) {
      await xpLogEarn(this.object, newXP - curXP, newXP, this.object?.system?.experience.total, "manual adjustment", "Self");
    }

    return await this.object.update(formData);
  }

  /**
   * Records the state of all active effects on the actor and then suspends them.
   * This is used to enable manual editing without an infinite loop from the two being combined
   * Note that this returns a state, which is REQUIRED to restore the original AE state
   *
   * The two modes are deliberately asymmetric:
   *  - persistChanges=false uses updateSource(), which is an in-memory change with no DB write
   *  - persistChanges=true must hit the DB, so those changes are batched into a single
   *    updateEmbeddedDocuments() call per parent. Writing them one-at-a-time cost two round
   *    trips per effect, and since every XP purchase adds an effect, granting XP to a
   *    high-XP character fired hundreds of sequential writes.
   * @param actor
   * @param persistChanges - defaults to False, and generally should be. For GM XP granting, this should be True
   * @returns {Promise<{directEffects: *[], itemEffects: {}}>}
   */
  static async beginEditMode(actor, persistChanges=false) {
    // Store initial state
    CONFIG.logger.debug(`Beginning Edit mode for ${actor.name}`);
    // Track both direct and item-based effects
    const initialState = {
      directEffects: [],
      itemEffects: {},
    };

    // Record direct effects
    const actorEffectUpdates = [];
    for (const effect of actor.effects) {
      initialState.directEffects.push({
        id: effect.id,
        disabled: effect.disabled,
      });
      // update source so we don't persist disabling effects
      if (!persistChanges) {
        effect.updateSource({disabled: true});
      } else {
        actorEffectUpdates.push({_id: effect.id, disabled: true});
      }
    }
    if (actorEffectUpdates.length > 0) {
      await actor.updateEmbeddedDocuments("ActiveEffect", actorEffectUpdates);
    }

    // Record item-based effects
    for (const item of actor.items) {
      CONFIG.logger.debug(`> examining ${item.name}`);
      initialState.itemEffects[item.id] = [];
      const itemEffectUpdates = [];
      for (const effect of item.effects) {
        CONFIG.logger.debug(`>> Recording state for ${effect.name}`);
        initialState.itemEffects[item.id].push({
          id: effect.id,
          disabled: effect.disabled,
        });
        CONFIG.logger.debug(`>> Disabling AE for ${effect.name}`);
        if (!persistChanges) {
          effect.updateSource({disabled: true});
        } else {
          itemEffectUpdates.push({_id: effect.id, disabled: true});
        }
      }
      if (itemEffectUpdates.length > 0) {
        await item.updateEmbeddedDocuments("ActiveEffect", itemEffectUpdates);
      }
    }

    // pass the object rather than pre-serializing it; a template literal would run
    // JSON.stringify on every call even when debug logging is disabled
    CONFIG.logger.debug("Final initial state:", initialState);
    return initialState;
  }

  static async endEditMode(actor, originalState, persistChanges=false) {
    CONFIG.logger.debug(`Ending Edit mode for ${actor.name} - original state:`, originalState);
    // revert the state for direct effects
    const actorEffectUpdates = [];
    for (const effect of actor.effects) {
      const locatedEffect = originalState.directEffects.find((s) => s.id === effect.id);
      if (locatedEffect && effect.disabled !== locatedEffect.disabled) {
        // update source so we don't persist disabling effects
        if (!persistChanges) {
          effect.updateSource({disabled: locatedEffect.disabled});
        } else {
          actorEffectUpdates.push({_id: effect.id, disabled: locatedEffect.disabled});
        }
      }
    }
    if (actorEffectUpdates.length > 0) {
      await actor.updateEmbeddedDocuments("ActiveEffect", actorEffectUpdates);
    }

    // revert the state for item-based effects
    for (const item of actor.items) {
      CONFIG.logger.debug(`> examining ${item.name}`);
      if (item.id in originalState.itemEffects) {
        const storedItemState = originalState.itemEffects[item.id];
        CONFIG.logger.debug("> found item AEs in stored state:", storedItemState);
        const itemEffectUpdates = [];
        for (const effect of item.effects) {
          CONFIG.logger.debug(`>> examining ${effect.name}`);
          const storedEffectState = storedItemState.find((s) => s.id === effect.id);
          if (storedEffectState && effect.disabled !== storedEffectState.disabled) {
            CONFIG.logger.debug(">>> found a stored state for this effect, making adjustments");
            if (!persistChanges) {
              effect.updateSource({disabled: storedEffectState.disabled});
            } else {
              itemEffectUpdates.push({_id: effect.id, disabled: storedEffectState.disabled});
            }
          } else {
            CONFIG.logger.debug(">>> no stored state for this effect or the state is the same, not making adjustments");
          }
        }
        if (itemEffectUpdates.length > 0) {
          await item.updateEmbeddedDocuments("ActiveEffect", itemEffectUpdates);
        }
      } else {
        CONFIG.logger.debug("> no item AEs in stored state, skipping further processing");
      }
    }
  }
}

/**
 * Serializes all mutations of the xpLog flag.
 *
 * The log lives in a single flag holding one array, so every write is a read-modify-write.
 * Two purchases confirmed in quick succession would both read the pre-write log and the
 * second setFlag would clobber the first entry, leaving its Active Effect on the actor with
 * no log row pointing at it - an orphaned purchase that can never be refunded.
 *
 * The flag is re-read inside the queued section, so each mutation sees the previous one's result.
 * @param actor - ffgActor object
 * @param mutate - receives the current log array, returns the new one
 * @returns {Promise<void>}
 */
let xpLogQueue = Promise.resolve();
export async function queueXpLogUpdate(actor, mutate) {
  const update = xpLogQueue.then(async () => {
    const xpLog = actor.getFlag("starwarsffg", "xpLog") || [];
    await actor.setFlag("starwarsffg", "xpLog", mutate(xpLog));
  });
  // swallow failures on the chain itself so one bad write doesn't wedge every later one
  xpLogQueue = update.catch(() => {});
  return update;
}

/**
 * Adds a SPEND log entry to the actor's XP log (accessed via the notebook under specializations)
 * @param actor - ffgActor object
 * @param action - action taken (e.g. "skill rank Astrogation 1 --> 2")
 * @param cost - XP spent
 * @param available - XP available
 * @param total - XP total
 * @param statusId - ID of the associated active effect (if in use)
 * @returns {Promise<void>}
 */
export async function xpLogSpend(actor, action, cost, available, total, statusId=undefined) {
  const date = new Date().toISOString().slice(0, 10);
  const newEntry = {
    action: 'purchased',
    id: statusId,
    xp: {
      cost: cost,
      available: available,
      total: total,
    },
    date: date,
    description: action,
  };
  await queueXpLogUpdate(actor, (xpLog) => [newEntry, ...xpLog]);
  await notifyXpSpend(actor, action);
}

/**
 * Whisper the GM notifying them of spending XP
 * @param actor
 * @param action
 * @returns {Promise<void>}
 */
async function notifyXpSpend(actor, action) {
  if (game.settings.get("starwarsffg", "notifyOnXpSpend")) {
    const chatData = {
      speaker: {
        actor: actor,
      },
      content: `bought ${action}`,
      whisper: ChatMessage.getWhisperRecipients("GM"),
    };
    await ChatMessage.create(chatData);
  }
}

/**
 * Adds a GRANT log entry to the actor's XP log (accessed via the notebook under specializations)
 * @param actor - ffgActor object
 * @param grant - XP granted
 * @param available - XP available
 * @param total - XP total
 * @param note - note about the grant
 * @param granter - string for who did the granting
 * @returns {Promise<void>}
 */
export async function xpLogEarn(actor, grant, available, total, note, granter="GM", statusId=undefined) {
  const date = new Date().toISOString().slice(0, 10);
  let action;
  if (granter === "GM") {
    action = "granted";
  } else {
    action = "adjusted";
  }
  const newEntry = {
    action: action,
    id: statusId, // XP grants are not done by Active Effects
    xp: {
      cost: grant,
      available: available,
      total: total,
    },
    date: date,
    description: note,
  };
  await queueXpLogUpdate(actor, (xpLog) => [newEntry, ...xpLog]);
}

/**
 * Undoes an XP grant, e.g., from removing a species
 * @param actor - ffgActor object
 * @param undone - XP undone
 * @param available - (new) XP available
 * @param total - (new) XP total
 * @returns {Promise<void>}
 */
export async function xpLogUndo(actor, undone, available, total) {
  const date = new Date().toISOString().slice(0, 10);
  const newEntry = {
    action: "undid",
    id: undefined,
    xp: {
      cost: undone,
      available: available,
      total: total,
    },
    date: date,
    description: "Species XP",
  };
  await queueXpLogUpdate(actor, (xpLog) => [newEntry, ...xpLog]);
}
