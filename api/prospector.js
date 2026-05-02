// api/prospector.js
// Forge Prospector — Finds bilingual business owners automatically
// Sources: Google Maps Places API + Sunbiz.org + Website scraping + Email generation

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
  const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;

  const { industry, city, state, sources, limit = 50 } = req.body;

  if (!industry || !city) {
    return res.status(400).json({ error: 'Industry and city are required' });
  }

  const prospects = [];

  // ── SOURCE 1: GOOGLE MAPS ─────────────────────────────────────────────
  if (sources?.includes('google') || !sources) {
    try {
      const query      = `${industry} ${city} ${state || ''}`.trim();
      const mapsUrl    = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_API_KEY}`;
      const mapsRes    = await fetch(mapsUrl);
      const mapsData   = await mapsRes.json();

      if (mapsData.results?.length) {
        for (const place of mapsData.results.slice(0, Math.min(limit, 20))) {
          // Get place details for website + phone
          let website = null;
          let phone   = place.formatted_phone_number || null;

          try {
            const detailUrl  = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=website,formatted_phone_number,name,formatted_address&key=${GOOGLE_MAPS_API_KEY}`;
            const detailRes  = await fetch(detailUrl);
            const detailData = await detailRes.json();
            website = detailData.result?.website || null;
            phone   = detailData.result?.formatted_phone_number || phone;
          } catch(e) { /* non-fatal */ }

          const domain      = website ? extractDomain(website) : null;
          const ownerInfo   = domain ? await scrapeOwnerFromWebsite(website, ANTHROPIC_API_KEY) : null;
          const emailGuess  = ownerInfo?.name && domain ? generateEmails(ownerInfo.name, domain) : [];
          const langSignal  = ownerInfo?.name ? detectLanguage(ownerInfo.name) : detectLanguage(place.name);

          prospects.push({
            id:               `gm-${place.place_id}`,
            source:           'Google Maps',
            business_name:    place.name,
            owner_name:       ownerInfo?.name || null,
            title:            ownerInfo?.title || 'Owner',
            address:          place.formatted_address,
            city,
            state:            state || '',
            phone,
            website,
            domain,
            emails:           emailGuess,
            best_email:       emailGuess[0] || null,
            language:         langSignal.language,
            lang_confidence:  langSignal.confidence,
            lang_reasoning:   langSignal.reasoning,
            industry,
            status:           'new',
          });
        }
      }
    } catch (e) {
      console.error('Google Maps error:', e);
    }
  }

  // ── SOURCE 2: SUNBIZ.ORG (Florida only) ───────────────────────────────
  if ((sources?.includes('sunbiz') || !sources) && (state === 'FL' || !state)) {
    try {
      const sunbizProspects = await searchSunbiz(industry, city, ANTHROPIC_API_KEY);
      prospects.push(...sunbizProspects);
    } catch (e) {
      console.error('Sunbiz error:', e);
    }
  }

  // ── DEDUPLICATE ────────────────────────────────────────────────────────
  const seen    = new Set();
  const unique  = prospects.filter(p => {
    const key = (p.business_name + p.city).toLowerCase().replace(/\s/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── SORT: Spanish first (higher priority for Callforge) ───────────────
  unique.sort((a, b) => {
    if (a.language === 'es' && b.language !== 'es') return -1;
    if (b.language === 'es' && a.language !== 'es') return 1;
    return 0;
  });

  const spanish = unique.filter(p => p.language === 'es').length;
  const english = unique.filter(p => p.language === 'en').length;

  return res.status(200).json({
    success:   true,
    total:     unique.length,
    spanish,
    english,
    prospects: unique,
    query:     { industry, city, state },
  });
}


// ── HELPERS ───────────────────────────────────────────────────────────────

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch(e) {
    return null;
  }
}

async function scrapeOwnerFromWebsite(url, anthropicKey) {
  if (!url || !anthropicKey) return null;

  try {
    // Fetch the website homepage
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 5000);
    const pageRes    = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Callforge/1.0)' }
    });
    clearTimeout(timeout);

    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    // Use Claude Haiku to extract owner name from HTML (cheap + fast)
    const prompt = `Extract the business owner's name and title from this website HTML.
Look for: "About Us", "Meet the team", "Founded by", "Owner:", copyright footer, or any person's name associated with ownership.

HTML (first 3000 chars):
${html.substring(0, 3000)}

Respond ONLY with JSON, no markdown:
{"name": "First Last or null", "title": "Owner/Broker/etc or null"}

If you cannot find a real person's name, return {"name": null, "title": null}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const claudeData = await claudeRes.json();
    const raw        = claudeData.content[0].text.trim()
      .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed     = JSON.parse(raw);

    return parsed.name ? parsed : null;
  } catch(e) {
    return null;
  }
}

function generateEmails(fullName, domain) {
  if (!fullName || !domain) return [];

  const parts     = fullName.toLowerCase().trim().split(/\s+/);
  const first     = parts[0] || '';
  const last      = parts[parts.length - 1] || '';
  const firstInit = first[0] || '';
  const lastInit  = last[0] || '';

  // Most common business email patterns in order of likelihood
  const patterns = [
    `${first}@${domain}`,
    `${first}.${last}@${domain}`,
    `${firstInit}${last}@${domain}`,
    `${first}${last}@${domain}`,
    `${firstInit}.${last}@${domain}`,
    `info@${domain}`,
    `hello@${domain}`,
    `contact@${domain}`,
  ];

  // Remove duplicates and invalid patterns
  return [...new Set(patterns)].filter(e =>
    e.includes('@') && e.split('@')[0].length > 0
  );
}

function detectLanguage(name) {
  if (!name) return { language: 'en', confidence: 'low', reasoning: 'No name provided' };

  const HISPANIC_SURNAMES = [
    'garcia','martinez','lopez','rodriguez','gonzalez','hernandez','perez',
    'sanchez','ramirez','torres','flores','rivera','gomez','diaz','reyes',
    'morales','jimenez','ruiz','alvarez','romero','vargas','castillo','mendoza',
    'ramos','ortiz','delgado','chavez','herrera','medina','aguilar','garza',
    'guerrero','miranda','santos','mendez','vega','suarez','nunez','rojas',
    'dominguez','avila','mora','molina','silva','contreras','soto','escobar',
    'figueroa','fuentes','serrano','leon','luna','lara','salazar','moran',
    'acosta','ibarra','velazquez','cardenas','cabrera','rios','montes','campos',
    'espinoza','pena','padilla','santiago','peralta','calderon','ochoa',
    'guerrero','cortez','navarro','rivas','meza','carrillo','macias','villa',
    'rosales','montoya','juarez','paredes','quintero','pizarro','estrada',
    'mata','trujillo','carrasco','montalvo','zamora','villanueva','tapia',
    'pacheco','esquivel','lozano','delacruz','de la cruz','del rio','de leon',
  ];

  const nameLower = name.toLowerCase();
  const parts     = nameLower.split(/\s+/);
  const lastName  = parts[parts.length - 1];

  // Check full name and last name
  const isHispanic = HISPANIC_SURNAMES.some(surname =>
    nameLower.includes(surname) || lastName === surname
  );

  if (isHispanic) {
    return {
      language:   'es',
      confidence: 'high',
      reasoning:  `Hispanic surname detected in "${name}"`,
    };
  }

  // Check for Spanish-language business names
  const spanishWords = ['casa','grupo','sol','hermanos','asociados',
    'servicios','inmobiliaria','seguros','consultora','inversiones'];
  const hasSpanishWord = spanishWords.some(w => nameLower.includes(w));

  if (hasSpanishWord) {
    return {
      language:   'es',
      confidence: 'medium',
      reasoning:  'Spanish words detected in business/name',
    };
  }

  return {
    language:   'en',
    confidence: 'medium',
    reasoning:  'No Hispanic surname or Spanish words detected',
  };
}

async function searchSunbiz(industry, city, anthropicKey) {
  // Sunbiz doesn't have a public API so we use their search URL
  // and parse the results — this is public data
  const prospects = [];

  try {
    const industryMap = {
      'Real Estate':        'real estate',
      'Insurance':          'insurance',
      'Mortgage':           'mortgage',
      'Financial Services': 'financial',
      'Auto Sales':         'auto',
      'Construction':       'construction',
    };

    const searchTerm = industryMap[industry] || industry.toLowerCase();
    const sunbizUrl  = `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?inquiryType=EntityName&inquiryDirectionType=ForwardList&searchNameOrder=&masterFileNumber=&inquiryId=&corporationNameSearchString=${encodeURIComponent(searchTerm + ' ' + city)}&listNameOrder=&fileNumber=&searchTerm=${encodeURIComponent(searchTerm)}&activeSearchOnly=true`;

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 8000);
    const sunbizRes  = await fetch(sunbizUrl, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Callforge/1.0)' }
    });
    clearTimeout(timeout);

    if (!sunbizRes.ok) return prospects;
    const html = await sunbizRes.text();

    // Use Claude Haiku to parse Sunbiz HTML results
    if (anthropicKey && html.length > 100) {
      const parsePrompt = `Parse this Florida Sunbiz business registry HTML and extract business listings.

HTML (first 4000 chars):
${html.substring(0, 4000)}

Extract up to 10 businesses. For each return:
- business_name: the registered business name
- file_number: the FL document number if visible
- status: Active or Inactive

Respond ONLY with JSON array, no markdown:
[{"business_name": "...", "file_number": "...", "status": "Active"}]

Return empty array [] if no results found.`;

      const parseRes  = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'x-api-key':         anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages:   [{ role: 'user', content: parsePrompt }],
        }),
      });

      const parseData = await parseRes.json();
      const rawParse  = parseData.content[0].text.trim()
        .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const businesses = JSON.parse(rawParse);

      for (const biz of businesses.filter(b => b.status === 'Active')) {
        const langSignal = detectLanguage(biz.business_name);
        const domain     = guessDomainFromName(biz.business_name);
        const emails     = domain ? [`info@${domain}`, `contact@${domain}`] : [];

        prospects.push({
          id:              `sb-${biz.file_number || Math.random().toString(36).substr(2,9)}`,
          source:          'Sunbiz.org',
          business_name:   biz.business_name,
          owner_name:      null,
          title:           'Owner',
          address:         city + (', FL'),
          city,
          state:           'FL',
          phone:           null,
          website:         domain ? `https://www.${domain}` : null,
          domain,
          emails,
          best_email:      emails[0] || null,
          language:        langSignal.language,
          lang_confidence: langSignal.confidence,
          lang_reasoning:  langSignal.reasoning,
          industry,
          status:          'new',
          file_number:     biz.file_number,
        });
      }
    }
  } catch(e) {
    console.error('Sunbiz parse error:', e);
  }

  return prospects;
}

function guessDomainFromName(businessName) {
  // Convert business name to likely domain
  const clean = businessName
    .toLowerCase()
    .replace(/\b(llc|inc|corp|ltd|co|group|associates|and|&|the|of)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
  return clean.length > 2 ? `${clean}.com` : null;
}
