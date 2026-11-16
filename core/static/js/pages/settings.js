import { api } from '../api.js';
import { busy, fieldHtml, icon, readForm, toast, toastError } from '../ui.js';

export default async function settingsPage(ctx) {
  ctx.setTitle(`${icon('settings', 20)}<span>Settings</span>`);
  const { restaurant, settings: s } = await api('/api/settings');
  const features = ctx.me.plan?.features || [];

  const sections = [
    { title: 'Restaurant', icon: 'store', fields: [
      { name: 'r_name', label: 'Restaurant name', value: restaurant.name, required: true },
      { name: 'r_phone', label: 'Phone', value: restaurant.phone },
      { name: 'r_email', label: 'Email', value: restaurant.email },
      { name: 'r_city', label: 'City', value: restaurant.city },
      { name: 'r_address', label: 'Address (printed on bills)', value: restaurant.address, full: true },
    ] },
    { title: 'Billing', icon: 'receipt', fields: [
      { name: 'bill_footer', label: 'Bill footer message', value: s.bill_footer, full: true },
      { name: 'service_charge_percent', label: 'Service charge % (dine-in)', type: 'number', value: s.service_charge_percent, min: 0, max: 30, step: '0.5' },
      { name: 'round_off', label: 'Round off bill totals to the nearest rupee', type: 'switch', value: s.round_off },
      { name: 'gst_enabled', label: 'Charge GST on bills', type: 'switch', value: s.gst_enabled, hint: 'Leave off if your restaurant is not registered for GST — bills will show no GST.' },
      { name: 'gst_percent', label: 'GST %', type: 'number', value: s.gst_percent, min: 0, max: 28, step: '0.5' },
      { name: 'gstin', label: 'GSTIN', value: s.gstin },
    ] },
    { title: 'Ordering & delivery', icon: 'qr', fields: [
      { name: 'online_ordering', label: 'Allow guests to order from the table QR code', type: 'switch', value: s.online_ordering, full: true, hint: features.includes('qr_ordering') ? '' : 'QR ordering is not part of your plan.' },
      { name: 'delivery_enabled', label: 'Home delivery', type: 'switch', value: s.delivery_enabled, hint: features.includes('delivery') ? '' : 'Delivery is not part of your plan.' },
      { name: 'delivery_fee', label: 'Delivery fee (₹)', type: 'number', value: s.delivery_fee, min: 0 },
      { name: 'delivery_area', label: 'Delivery area', value: s.delivery_area, full: true, placeholder: 'e.g. Within 5 km of MG Road' },
    ] },
    { title: 'Kitchen', icon: 'kitchen', fields: [
      { name: 'stations', label: 'Kitchen stations (comma separated)', value: (s.stations || []).join(', '), full: true, hint: 'Each station gets its own tickets — e.g. Main Kitchen, Tandoor, Beverages.' },
      { name: 'kitchen_amber_minutes', label: 'Timer turns amber after (min)', type: 'number', value: s.kitchen_amber_minutes, min: 1 },
      { name: 'kitchen_red_minutes', label: 'Timer turns red after (min)', type: 'number', value: s.kitchen_red_minutes, min: 1 },
    ] },
    { title: 'Online payments (Razorpay)', icon: 'card', note: `Guests can pay their bill online from the QR menu, and cashiers can collect with Razorpay. Money goes to <b>your own</b> Razorpay account. ${features.includes('online_payments') ? '' : '<b>Online payments are not part of your plan.</b>'}`, fields: [
      { name: 'razorpay_key_id', label: 'Key ID', value: s.razorpay_key_id, placeholder: 'rzp_live_…' },
      { name: 'razorpay_key_secret', label: `Key secret ${s.razorpay_secret_set ? '(saved — leave blank to keep)' : ''}`, type: 'password', autocomplete: 'off' },
      { name: 'razorpay_webhook_secret', label: `Webhook secret ${s.razorpay_webhook_set ? '(saved)' : '(optional)'}`, type: 'password', autocomplete: 'off', full: true, hint: `Webhook URL: ${location.origin}/api/webhooks/razorpay — events: payment.captured` },
    ] },
    { title: 'Hardware', icon: 'printer', fields: [
      { name: 'printer_bill', label: 'Bill printer name', value: s.printer_bill, placeholder: 'e.g. EPSON TM-T82 (counter)' },
      { name: 'printer_kitchen', label: 'Kitchen printer name', value: s.printer_kitchen },
      { name: 'cash_drawer', label: 'Cash drawer connected to the bill printer', type: 'switch', value: s.cash_drawer, full: true, hint: 'Bills and KOTs print through the browser print dialog — choose the printer once and tick "remember".' },
    ] },
  ];

  ctx.el.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Settings</h1><div class="sub">Restaurant details, bills, ordering, kitchen and payments.</div></div></div>
    <form id="sform" class="col" style="gap:16px;max-width:900px">
      ${sections.map((sec) => `<div class="card"><div class="card-head">${icon(sec.icon, 18)}<h3>${sec.title}</h3></div><div class="card-body">
        ${sec.note ? `<div class="notice" style="margin-bottom:16px">${icon('info')}<div>${sec.note}</div></div>` : ''}
        <div class="form-grid">${sec.fields.map(fieldHtml).join('')}</div></div></div>`).join('')}
      <div class="row" style="position:sticky;bottom:12px"><span class="spacer"></span>
        ${s.razorpay_key_id ? `<button type="button" class="btn danger-ghost" id="clear-rzp">${icon('trash')} Remove Razorpay keys</button>` : ''}
        <button class="btn primary lg" type="submit">${icon('check')} Save settings</button></div>
    </form>`;

  const all = sections.flatMap((x) => x.fields);
  const form = ctx.el.querySelector('#sform');
  const save = async (extra = {}) => {
    const v = readForm(form, all);
    const restaurantInfo = { name: v.r_name, phone: v.r_phone, email: v.r_email, city: v.r_city, address: v.r_address };
    const settings = { ...v, ...extra };
    Object.keys(restaurantInfo).forEach((k) => delete settings[`r_${k}`]);
    if (!settings.razorpay_key_secret) delete settings.razorpay_key_secret;
    if (!settings.razorpay_webhook_secret) delete settings.razorpay_webhook_secret;
    await api('/api/settings', { method: 'PUT', body: { restaurant: restaurantInfo, settings } });
    await ctx.refreshMe();
    toast('Settings saved');
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    busy(form.querySelector('[type=submit]'), () => save().catch(toastError));
  });
  ctx.el.querySelector('#clear-rzp')?.addEventListener('click', async () => { try { await save({ clear_razorpay: true }); settingsPage(ctx); } catch (e) { toastError(e); } });
}
