// Backfill faturamento for blackbox leads missing it
// Run this as a bookmarklet from mktlab.app (needs auth cookies)
(function() {
  var SUPA_URL = 'https://iaompeiokjxbffwehhrx.supabase.co';
  var SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhb21wZWlva2p4YmZmd2VoaHJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMjI5MDIsImV4cCI6MjA5MDc5ODkwMn0.D-rf7H8F21LyslQxmr6AGM13kWTWs7f05OcnBt5kbxg';

  var leads = [
    {id:"e6b7009b-c1c7-43f2-9fa2-58211c546ad4",m:"71be5ca0-61a6-4a10-89ed-9050dfe4f51c"},
    {id:"f0cde4cf-c0a5-4cbb-b073-afe924c3f1bf",m:"71b26dfb-ffaf-4319-9c69-d31fed0d3405"},
    {id:"1b32c136-cd55-49e6-8eaf-3cc48cb9419f",m:"1e9e7da2-fb20-40b6-a2f0-7e51883a5842"},
    {id:"90a6e106-5bc4-4f6f-865a-08512af3a315",m:"1ebad355-24ae-479b-93df-161433db3a3a"},
    {id:"148e3952-b0ed-4270-a5e5-24cffed89df4",m:"972afe2b-04fa-4f48-8c38-1d931bc10473"},
    {id:"78e53601-b32c-4ac5-98b5-120b7d3ee97b",m:"40437012-d119-4ac9-ab51-6ca640b2e776"},
    {id:"9bc10f7b-3465-408e-8ba9-0615189f3c0a",m:"a6023cbb-d025-498b-ab26-172b5bd69686"},
    {id:"0d4a7fff-0584-4afb-9698-e7fec3d55a03",m:"7adc4f13-7748-4e71-bf0a-7ef733ccbec5"},
    {id:"ef97b19d-6400-4a6d-b40b-3bcc281e5473",m:"b4b8fac4-0939-42bb-aaa7-d89fdb01b1ba"},
    {id:"6dfc182b-2dd4-4d11-b3a5-711e79facf49",m:"b9d2bc47-26d1-4cdc-9a31-cfbd1b0e3338"},
    {id:"c5414d07-c51b-409d-a975-65946bf5bcc2",m:"705d737a-05eb-48ec-baff-963e57c88341"},
    {id:"10ec237f-a4ba-4d2b-bd34-75724e7c50c1",m:"bf1a4600-2c69-4933-a378-43e020463ddd"},
    {id:"2b09777c-4426-46b3-8793-fd1a5f81fd57",m:"52f19d98-da8d-47a1-ac5f-c938d2d02479"},
    {id:"88a541e4-f627-4c26-8a66-6a9efefc4ade",m:"53f2688f-4380-4886-a932-6eb67e9e78bd"},
    {id:"0dd11be5-3ec6-48f7-9d45-3e8d659894b4",m:"6b189b4b-0ef6-4d25-baec-7253c505b6ae"},
    {id:"c02f5415-3f07-4f7a-b694-5337bf6b8a75",m:"7dd24e02-9379-4601-a9be-203de7765d1b"},
    {id:"65714183-5cdc-41c4-b6e8-5b571e900477",m:"7fbd09c3-a334-4780-84e7-f6295779c06c"},
    {id:"917facb4-75cd-437f-86dc-f7a1abf409d3",m:"90da1668-d5d0-4d27-acd7-ab9f5d2fa80e"},
    {id:"55926eab-a807-4f08-b652-3ebe2b6a1acd",m:"ca988a0f-d5a3-4d61-87f6-48bd5f412963"},
    {id:"77793273-53a6-40a9-aee9-ae0a428a2ecc",m:"dbd65e20-5342-4ef5-bd13-dfa10de8f4d5"},
    {id:"94cddeaa-2f8d-410d-82f0-acfb85560167",m:"dfa49a66-fa6e-47ad-93f7-8f78e329dded"},
    {id:"41292268-334f-4089-a09b-9a7b6757c8a8",m:"ed86c704-9a91-482d-a3ee-1f2f91b041be"},
    {id:"638aec0e-ebfa-49a8-bf3c-2ed74cd6cb1a",m:"ed9417b6-3bd1-4db1-a160-10e574109e1b"},
    {id:"6d25dcc0-6858-4f13-93aa-9eec11dad9f0",m:"b47305e3-47f5-4dee-9e14-484eadef5955"},
    {id:"67d7640a-8c64-443b-9488-82ae252be6f0",m:"df9e170a-642e-40db-a628-04bf401c0160"},
    {id:"4027f337-44e6-47c3-9b03-d9b670fffc7f",m:"cd7eb4eb-1f91-453a-9dfb-80b15ca0277a"},
    {id:"a1998aa1-a15a-4e70-a1e9-7afc292f1418",m:"3f0ac916-48e1-4a19-84cf-44c9f068377f"},
    {id:"19e3e2de-2ad3-45de-ae78-34be9795910f",m:"174cb2e0-ba6a-4a77-9ed1-784ce076663d"},
    {id:"0e917478-325d-4460-b3f7-5b53aa50fcd8",m:"6b1c0b14-d153-4f48-aaf0-eea354d82156"},
    {id:"cdea273d-53b3-4581-aaf0-21d65c06df11",m:"ad5d55e0-8ec3-4889-8909-ca5c0f0cc8fb"},
    {id:"77dc7197-a588-4048-b519-ef181d5ede8a",m:"2c164824-6678-4c5f-a401-bfa704308404"},
    {id:"095d1132-e764-4348-9380-c1787c0c08d0",m:"09477904-65a3-41d9-81a0-0c781d187eb3"},
    {id:"d61239cf-53dd-4156-8e05-34d6f2f6aec2",m:"fd831866-a5b0-43b8-88f6-208afa741959"},
    {id:"8cc36cb8-d45d-4993-9a2d-78d329c72179",m:"30ff2134-de71-4de3-bfe0-5a6304bd46d2"},
    {id:"2dac7e86-b01e-41c4-a14f-540b97fe9cdf",m:"60960cc8-a19d-4dd5-9254-f4be8b2760f4"},
    {id:"72e83a2b-7ad4-4440-b630-39ee3fc6db2e",m:"63aae643-6bde-4bd7-9031-504b658d8f0e"},
    {id:"c20abf56-3c61-49a4-9b0c-dfdbd8934ab7",m:"f635f9c3-69bd-4c20-b6d3-e33d83effbff"},
    {id:"d675c871-2c85-482c-bdfd-fb1dffd2990e",m:"a49590e0-dfbc-44ac-bf71-1d876030f422"}
  ];

  function mktFetch(url) {
    return fetch(url, { credentials: 'include' }).then(function(r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  function parseCustomFields(categoriesData) {
    var result = {};
    var categories = categoriesData.categories || categoriesData;
    if (!Array.isArray(categories)) return result;
    categories.forEach(function(cat) {
      if (!cat.items) return;
      cat.items.forEach(function(item) {
        var value = '';
        if (item.answer && item.answer.length > 0) value = item.answer.join('; ');
        if (!value && item.answerMultiChoice && item.answerMultiChoice.length > 0) {
          var sel = item.answerMultiChoice.filter(function(o) { return o.isSelected; }).map(function(o) { return o.value; });
          if (sel.length > 0) value = sel.join('; ');
        }
        result[item.title] = value;
      });
    });
    return result;
  }

  function supaUpdate(leadId, faturamento) {
    return fetch(SUPA_URL + '/rest/v1/leads?id=eq.' + leadId, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_KEY,
        'Authorization': 'Bearer ' + SUPA_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ faturamento: faturamento })
    });
  }

  var updated = 0, skipped = 0, errors = 0, idx = 0;
  var panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:#1a1a2e;color:#fff;padding:16px;border-radius:8px;font:14px monospace;min-width:320px;box-shadow:0 4px 20px rgba(0,0,0,.5)';
  panel.innerHTML = '<b>Backfill Faturamento</b><br>Processando 0/' + leads.length + '...';
  document.body.appendChild(panel);

  function processNext() {
    if (idx >= leads.length) {
      panel.innerHTML = '<b>Backfill Completo!</b><br>Atualizados: ' + updated + '<br>Sem faturamento no MKTLAB: ' + skipped + '<br>Erros: ' + errors;
      return;
    }
    var lead = leads[idx];
    idx++;
    panel.innerHTML = '<b>Backfill Faturamento</b><br>Processando ' + idx + '/' + leads.length + '...<br>Atualizados: ' + updated + ' | Sem dado: ' + skipped + ' | Erros: ' + errors;

    mktFetch('https://mktlab.app/crm/api/leads/' + lead.m + '/custom-fields-categories')
      .then(function(d) {
        var fields = parseCustomFields(d);
        var fat = fields['Faturamento da LP'] || fields['Faturamento'] || '';
        if (fat) {
          return supaUpdate(lead.id, fat).then(function(r) {
            if (r.ok) { updated++; }
            else { errors++; console.error('Supabase error for', lead.id, r.status); }
          });
        } else {
          skipped++;
        }
      })
      .catch(function(e) {
        errors++;
        console.error('Error for lead', lead.id, e);
      })
      .then(function() {
        setTimeout(processNext, 200);
      });
  }

  processNext();
})();
