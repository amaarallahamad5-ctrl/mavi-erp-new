'use strict';
// Purchases belong to an order; the fabric reference is optional and has no stock.
// Workshop rates belong to an existing item, whose quantity is never entered twice.
const express = require('express');
const { db, get, all, run, audit } = require('./db');
const A = require('./auth');
const D = require('./domain');
const router = express.Router();

const failure = (res, status, message) => res.status(status).json({ message });
function orderFor(req, res) {
  const order = get('SELECT id,code FROM orders WHERE code=?', req.params.code);
  if (!order) failure(res, 404, 'الأوردر غير موجود');
  return order;
}
function nonNegative(value, max) {
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'object' || String(value).trim() === '') return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max;
}
function positiveId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function normalise(type, body, order, existing = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const note = String(body.note ?? '').trim();
  if (note.length > 500) return null;
  if (type === 'fabric') {
    let fabric = null, fabricId = null, preserveOrphan = false;
    if (body.fabric_id !== undefined && body.fabric_id !== null && String(body.fabric_id).trim() !== '') {
      fabricId = positiveId(body.fabric_id);
      if (!fabricId) return null;
      fabric = get('SELECT id,name FROM fabric WHERE id=?', fabricId);
      // A broken old reference must never be silently detached on edit. Keep it
      // unchanged, or allow an explicit selection of a different valid fabric.
      preserveOrphan = !fabric && !!existing && Number(existing.fabric_id) === fabricId;
      if (!fabric && !preserveOrphan) return null;
    }
    // A name can be written directly on the purchase; creating a catalogue entry
    // first is optional. Keep an independent snapshot even if a name changes later.
    const name = String(body.fabric_name ?? fabric?.name ?? existing?.fabric_name ?? '').trim();
    if (name.length > 80 || !nonNegative(body.metres, 100000) || Number(body.metres) <= 0 ||
        !nonNegative(body.price_per_metre, 10000000) || !nonNegative(body.shipping_per_metre, 10000000)) return null;
    return { fabric_id: fabricId, name, metres: Number(body.metres), price: Number(body.price_per_metre), shipping: Number(body.shipping_per_metre), note, preserveOrphan };
  }
  if (type === 'other') {
    const label = String(body.label ?? '').trim();
    if (!label || label.length > 100 || !nonNegative(body.amount, 10000000)) return null;
    return { label, amount: Number(body.amount), note };
  }
  const itemId = positiveId(body.order_item_id), tailorId = positiveId(body.tailor_id);
  const item = itemId && get('SELECT id,qty FROM order_items WHERE id=? AND order_id=?', itemId, order.id);
  const tailor = tailorId && get('SELECT id,name,active FROM tailors WHERE id=?', tailorId);
  const sameReference = !!existing && !!tailorId && Number(existing.tailor_id) === tailorId;
  const blankReference = body.tailor_id == null || String(body.tailor_id).trim() === '';
  const keepDeleted = !!existing && existing.tailor_id == null && blankReference;
  // Inactive or deleted workshops remain usable only on their own old entry;
  // they cannot be selected for a new entry. Preserve the original name.
  if (!item || !nonNegative(body.unit_cost, 10000000) ||
      (!tailor && !sameReference && !keepDeleted) || (tailor && !tailor.active && !sameReference)) return null;
  const name = sameReference || keepDeleted ? existing.tailor_name : tailor.name;
  return { item_id: item.id, quantity: item.qty, tailor_id: tailorId, name, unit: Number(body.unit_cost), note,
    preserveOrphan: sameReference && !tailor };
}

function getOrderCosts(orderId) {
  return {
    purchases: all(`SELECT id,order_id,fabric_id,fabric_name,metres,price_per_metre,shipping_per_metre,note
                    FROM order_fabric_purchases WHERE order_id=? ORDER BY id`, orderId),
    workshops: all(`SELECT w.id,w.order_id,w.order_item_id,w.tailor_id,w.tailor_name,w.unit_cost,w.note,
                           COALESCE(i.qty,w.quantity) AS quantity,
                           CASE WHEN i.id IS NULL THEN 1 ELSE 0 END AS legacy_quantity,
                           COALESCE(NULLIF(i.description,''),s.name) AS item_name, t.name AS current_tailor_name,
                           t.active AS current_tailor_active
                    FROM order_workshop_costs w
                    LEFT JOIN order_items i ON i.id=w.order_item_id AND i.order_id=w.order_id
                    LEFT JOIN styles s ON s.id=i.style_id
                    LEFT JOIN tailors t ON t.id=w.tailor_id
                    WHERE w.order_id=? ORDER BY w.id`, orderId),
    extras: all('SELECT id,order_id,label,amount,note FROM order_other_costs WHERE order_id=? ORDER BY id', orderId),
  };
}

router.get('/orders/:code/cost-purchases', A.requireOwner, (req, res) => {
  const order = orderFor(req, res);
  if (order) res.json(getOrderCosts(order.id));
});

for (const type of ['fabric', 'workshop', 'other']) {
  const table = {fabric:'order_fabric_purchases',workshop:'order_workshop_costs',other:'order_other_costs'}[type];
  const endpoint = '/orders/:code/cost-purchases/' + type;
  const invalid = 'راجعي بيانات البند: أمتار وأسعار الخامة، أو قطعة الأوردر والورشة وأجر القطعة، أو اسم ومبلغ المصروف.';
  router.post(endpoint, A.requireOwner, (req, res) => {
    const order = orderFor(req, res);
    if (!order) return;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return failure(res, 400, invalid);
    const token = req.body.request_id == null ? null : String(req.body.request_id);
    if (token !== null && !/^[A-Za-z0-9_-]{8,100}$/.test(token)) return failure(res, 400, 'رمز العملية غير صحيح؛ أعيدي فتح الطلب.');
    const result = db.transaction(() => {
      const previous = token && get(`SELECT * FROM ${table} WHERE order_id=? AND request_id=?`, order.id, token);
      const input = normalise(type, req.body, order, previous || null);
      if (!input) return previous ? { conflict: true } : { invalid: true };
      if (previous) {
        const same = type === 'fabric'
          ? previous.fabric_id === input.fabric_id && previous.fabric_name === input.name && previous.metres === input.metres && previous.price_per_metre === input.price && previous.shipping_per_metre === input.shipping && (previous.note || '') === input.note
          : type === 'workshop'
            ? previous.order_item_id === input.item_id && previous.tailor_id === input.tailor_id && previous.unit_cost === input.unit && (previous.note || '') === input.note
            : previous.label === input.label && previous.amount === input.amount && (previous.note || '') === input.note;
        return same ? { id: previous.id, replay: true } : { conflict: true };
      }
      const id = type === 'fabric'
        ? run(`INSERT INTO order_fabric_purchases(order_id,fabric_id,fabric_name,metres,price_per_metre,shipping_per_metre,note,request_id) VALUES(?,?,?,?,?,?,?,?)`, order.id, input.fabric_id, input.name, input.metres, input.price, input.shipping, input.note, token).lastInsertRowid
        : type === 'workshop'
          ? run(`INSERT INTO order_workshop_costs(order_id,order_item_id,tailor_id,tailor_name,quantity,unit_cost,note,request_id) VALUES(?,?,?,?,?,?,?,?)`, order.id, input.item_id, input.tailor_id, input.name, input.quantity, input.unit, input.note, token).lastInsertRowid
          : run(`INSERT INTO order_other_costs(order_id,label,amount,note,request_id) VALUES(?,?,?,?,?)`, order.id, input.label, input.amount, input.note, token).lastInsertRowid;
      audit('order', order.id, 'cost_added', `user:${req.user.id}`, { type, id: Number(id) });
      return { id: Number(id), replay: false };
    })();
    if (result.invalid) return failure(res, 400, invalid);
    if (result.conflict) return failure(res, 409, 'حُفظ هذا البند سابقًا ببيانات مختلفة أو تغيّر مرجعه؛ افتحي الطلب من جديد وراجعيه قبل المحاولة.');
    res.status(result.replay ? 200 : 201).json({ ...result, totals: D.orderTotals(order.id) });
  });
  router.put(endpoint + '/:id', A.requireOwner, (req, res) => {
    const order = orderFor(req, res);
    if (!order) return;
    const id = positiveId(req.params.id);
    const old = id && get(`SELECT * FROM ${table} WHERE id=? AND order_id=?`, id, order.id);
    if (!old) return failure(res, 404, 'البند غير موجود في هذا الطلب');
    const input = normalise(type, req.body, order, old);
    if (!input) return failure(res, 400, invalid);
    db.transaction(() => {
      // SQLite rejects reassigning an already-broken FK even to its old value.
      // For that rare history, leave the reference column untouched on save.
      if (type === 'fabric' && input.preserveOrphan)
        run(`UPDATE order_fabric_purchases SET fabric_name=?,metres=?,price_per_metre=?,shipping_per_metre=?,note=? WHERE id=?`, input.name, input.metres, input.price, input.shipping, input.note, old.id);
      else if (type === 'fabric')
        run(`UPDATE order_fabric_purchases SET fabric_id=?,fabric_name=?,metres=?,price_per_metre=?,shipping_per_metre=?,note=? WHERE id=?`, input.fabric_id, input.name, input.metres, input.price, input.shipping, input.note, old.id);
      else if (type === 'workshop' && input.preserveOrphan)
        run(`UPDATE order_workshop_costs SET order_item_id=?,tailor_name=?,quantity=?,unit_cost=?,note=? WHERE id=?`, input.item_id, input.name, input.quantity, input.unit, input.note, old.id);
      else if (type === 'workshop')
        run(`UPDATE order_workshop_costs SET order_item_id=?,tailor_id=?,tailor_name=?,quantity=?,unit_cost=?,note=? WHERE id=?`, input.item_id, input.tailor_id, input.name, input.quantity, input.unit, input.note, old.id);
      else run(`UPDATE order_other_costs SET label=?,amount=?,note=? WHERE id=?`, input.label, input.amount, input.note, old.id);
      audit('order', order.id, 'cost_updated', `user:${req.user.id}`, { type, id: old.id });
    })();
    res.json({ totals: D.orderTotals(order.id) });
  });
  router.delete(endpoint + '/:id', A.requireOwner, (req, res) => {
    const order = orderFor(req, res);
    if (!order) return;
    const id = positiveId(req.params.id);
    const old = id && get(`SELECT id FROM ${table} WHERE id=? AND order_id=?`, id, order.id);
    if (!old) return failure(res, 404, 'البند غير موجود في هذا الطلب');
    db.transaction(() => {
      run(`DELETE FROM ${table} WHERE id=? AND order_id=?`, old.id, order.id);
      audit('order', order.id, 'cost_deleted', `user:${req.user.id}`, { type, id: old.id });
    })();
    res.json({ totals: D.orderTotals(order.id) });
  });
}

function costDetail(from, to) {
  const eligible = "status!='cancelled' AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')";
  const orders = all(`SELECT * FROM orders o WHERE ${eligible} AND mavi_cairo_date(created_at) BETWEEN ? AND ? ORDER BY id DESC`, from, to);
  const rows = orders.map(order => {
    const entries = getOrderCosts(order.id);
    const items = all(`SELECT i.id,i.qty,i.unit_cost,i.cost_material,i.cost_tailoring,i.cost_other_base,
                              COALESCE(NULLIF(i.description,''),NULLIF(s.name,''),i.style_id,'تصميم غير معروف') AS name
                       FROM order_items i LEFT JOIN styles s ON s.id=i.style_id WHERE i.order_id=?`, order.id)
      .map(item => ({ ...item, lines: all('SELECT label,quantity,unit_cost FROM item_cost_lines WHERE item_id=? ORDER BY id', item.id) }));
    const totals = D.orderTotals(order.id);
    const material = entries.purchases.reduce((sum, p) => sum + p.metres * (p.price_per_metre + p.shipping_per_metre), 0);
    const tailoring = entries.workshops.reduce((sum, w) => sum + w.quantity * w.unit_cost, 0);
    const metres = entries.purchases.reduce((sum, p) => sum + p.metres, 0);
    const orderOther = entries.extras.reduce((sum, e) => sum + e.amount, 0);
    let legacyMaterial = 0, legacyTailoring = 0, manual = 0;
    for (const item of items) {
      manual += item.qty * item.lines.reduce((sum, line) => sum + line.quantity * line.unit_cost, 0);
      if (item.cost_material !== null && item.cost_tailoring !== null && item.cost_other_base !== null) {
        legacyMaterial += item.qty * item.cost_material;
        legacyTailoring += item.qty * item.cost_tailoring;
      }
    }
    // Reconcile exactly to the saved item total; do not guess or re-price unknown history.
    const legacyOther = totals.cost - material - tailoring - orderOther - legacyMaterial - legacyTailoring - manual;
    return {
      code: order.code, date: order.created_at, status: order.status, ...entries, items,
      material, tailoring, order_other: orderOther, legacy_material: legacyMaterial, legacy_tailoring: legacyTailoring,
      manual, legacy_other: legacyOther, other: totals.cost - material - tailoring,
      metres, cost: totals.cost, sales: totals.total, profit: totals.profit, margin: totals.margin,
      tailoring_per_metre: metres > 0 && entries.workshops.length ? tailoring / metres : null,
    };
  });
  const sum = key => rows.reduce((total, row) => total + row[key], 0);
  const excluded = predicate => {
    const entries = all(`SELECT o.id FROM orders o WHERE ${predicate} AND mavi_cairo_date(created_at) BETWEEN ? AND ?`, from, to);
    return { orders: entries.length, recorded_cost: entries.reduce((total, order) => total + D.orderTotals(order.id).cost, 0) };
  };
  return {
    from, to, rows,
    totals: { material: sum('material'), tailoring: sum('tailoring'), legacy_material: sum('legacy_material'),
      legacy_tailoring: sum('legacy_tailoring'), order_other: sum('order_other'), manual: sum('manual'), legacy_other: sum('legacy_other'),
      other: sum('other'), total: sum('cost'), sales: sum('sales'), profit: sum('profit'), metres: sum('metres') },
    excluded: {
      cancelled: excluded("status='cancelled'"),
      unpriced: excluded("status!='cancelled' AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')"),
    },
  };
}
module.exports = { router, getOrderCosts, costDetail };
