#!/usr/bin/env node
/**
 * batch-migrate.mjs
 * Submits all sites from the CSV to the migration worker via Pixel's /api/migrate/start
 */

const PIXEL_URL = 'https://pixel.yourwebsiteexample.com';

const sites = [
  { url: 'https://www.klearcounseling.com/', name: 'Klear Counseling' },
  { url: 'https://www.oklahomacleaningservice.net/', name: 'Oklahoma Cleaning Service' },
  { url: 'https://www.eastwaltonsepticllc.com/', name: 'East Walton Septic LLC' },
  { url: 'https://www.jenkinselectric.net/', name: 'Jenkins Electric' },
  { url: 'https://www.cribstocrayonschildcare-me.com/', name: 'Cribs To Crayons Childcare' },
  { url: 'https://www.lentinecontracting.com/', name: 'Lentine Contracting' },
  { url: 'https://www.paulscialdonepainting-ma.com/', name: 'Paul Scialdone Painting' },
  { url: 'https://www.rdpoolserviceca.com/', name: 'R&D Pool Service' },
  { url: 'https://www.guruelectriciansllc.com/', name: 'GURU Electricians LLC' },
  { url: 'https://www.bgsplumbing-ca.com/', name: 'BGS Plumbing' },
  { url: 'https://www.saundersappraisalservices.com/', name: 'Saunders Appraisal Services' },
  { url: 'https://www.lovelymaidva.com/', name: 'Lovely Maid' },
  { url: 'https://www.theapplianceguysworthington.com/', name: 'The Appliance Guys Worthington' },
  { url: 'https://www.bvinouthomerepair.com/', name: 'BV In Out Home Repair' },
  { url: 'https://www.southsidetilellc.com/', name: 'Southside Tile LLC' },
  { url: 'https://www.goliathwoodworks-na.com/', name: 'Goliathwoodworks' },
  { url: 'https://www.dikort.com/', name: 'Dikort Electric' },
  { url: 'https://www.asphaltqualitycoat.com/', name: 'Asphalt Quality Coat LLC' },
  { url: 'https://www.eliascleaningservicestx.com/', name: 'Elias Cleaning Services' },
  { url: 'https://www.cotwofab.com/', name: 'COtwo Fab LLC' },
  { url: 'https://www.trustedcaregiverbarbara.com/', name: 'Trusted Caregiver' },
  { url: 'https://www.texomainstallers-tx.com/', name: 'Texoma Installers' },
  { url: 'https://www.jermaineshardwoodflooring.com/', name: "Jermaine's Hardwood flooring" },
  { url: 'https://www.wemakegracefulevents.com/', name: 'Graceful Events' },
  { url: 'https://www.trentkuhnbathroomremodeling.com/', name: 'Trent Kuhn Bathroom Remodeling' },
  { url: 'https://www.utahwickedwrenchauto.com/', name: 'Utah Wicked Wrench Auto LLC' },
  { url: 'https://www.handmedowntrade-ct.com/', name: 'HandMeDownTrade' },
  { url: 'https://www.fahrelectric.com/', name: 'Fahr Electric' },
  { url: 'https://www.pristinespaces208.com/', name: 'Pristine Spaces LLC' },
  { url: 'https://www.flinttownboxingclub.com/', name: 'Flint Town Boxing Club' },
  { url: 'https://www.thehandymandave.com/', name: 'Handyman Dave' },
  { url: 'https://www.4minteriors-ga.com/', name: '4M Interiors Inc' },
  { url: 'https://www.caplesconcreteservicesllc.com/', name: 'Caples Concrete Services LLC' },
  { url: 'https://www.personaltouchmaintenanceconstructionllc.com/', name: 'Personal touch Maintenance & Construction LLC' },
  { url: 'https://www.legacy6bookkeeping.com/', name: 'Legacy 6 Bookkeeping' },
  { url: 'https://www.thomasbartlettconstruction-ma.com/', name: 'Thomas Bartlett Construction' },
  { url: 'https://www.sengamllc.com/', name: 'Sengam LLC' },
  { url: 'http://www.aestheticoauto.com/', name: 'Aesthetico Auto' },
  { url: 'https://www.finessedetailing251.com/', name: 'Finesse Detailing' },
  { url: 'https://www.riverwindstables-in.com/', name: 'River Wind Stables' },
  { url: 'https://www.poohslittleangels.com/', name: 'Poohs Little Angels Childcare' },
  { url: 'https://www.aanddpowerwash.com/', name: 'A & D Powerwash' },
  { url: 'https://www.acupuncturehealingservices-wi.com/', name: 'Acupuncture Healing Services' },
  { url: 'https://www.4dautowraps.net/', name: '4D Auto Wraps' },
  { url: 'https://www.zankofa.farm/', name: 'Zankofa Farm' },
  { url: 'https://www.thehelperhandyman.com/', name: 'The Helper Handyman' },
  { url: 'https://www.handymanmike.org/', name: 'Handyman Mike' },
  { url: 'https://www.beradarchery.com/', name: 'Berad Archery LLC' },
  { url: 'https://www.jdwindowcleaningfl.com/', name: 'J D Window Cleaning' },
  { url: 'https://www.handyprohomesvs.com/', name: 'HandyPro Home Services LLC' },
  { url: 'https://www.handymanbunjy.com/', name: 'Handyman Bunjy' },
  { url: 'https://www.eliteexteriorcleaningllc.com/', name: 'Elite Exterior Cleaning LLC' },
  { url: 'https://www.northeasttubrefinishing.com/', name: 'Northeast Tub Refinishing' },
  { url: 'https://www.elitecarpetcleaningsc.com/', name: 'Elite Carpet Cleaning' },
  { url: 'https://www.riskovskyiiperformance.com/', name: 'Riskovsky II Performance' },
  { url: 'https://www.flowforceplumbing-ca.com/', name: 'Flow Force Plumbing' },
  { url: 'https://www.autodrandco.com/', name: 'Auto Dr & Co' },
  { url: 'https://www.jourdenpool.com/', name: 'Jourden Pool' },
  { url: 'https://www.firesidebbqtexas.com/', name: 'Fireside BBQ' },
  { url: 'https://www.elowinytherapeuticmassage.com/', name: 'Therapeutic Massage' },
  { url: 'https://www.hurricaneproof-nextiva.com/', name: 'Hurricane Proof' },
  { url: 'https://www.ctrprocoat.com/', name: 'CTR Pro Coat LLC' },
  { url: 'https://www.awbookkeepingservice.com/', name: 'A.W. Bookkeeping Service' },
  { url: 'https://www.worryfreecarpetcleaning-tx.com/', name: 'Worry Free Carpet Cleaning' },
  { url: 'https://www.kikosautocare.com/', name: 'Kikos Auto Care' },
  { url: 'https://www.allamericanplumbingdraincleaning.com/', name: 'All American Plumbing & Drain Cleaning Inc.' },
  { url: 'https://www.all-n1drivingschool.com/', name: 'ALL-N-1 Driving School' },
  { url: 'https://www.zuanypoolsservices.com/', name: 'Zuany Pools Services' },
  { url: 'https://www.pupperfectioncypress.com/', name: 'Pup Perfection' },
  { url: 'https://www.mwcarcleaningva.com/', name: 'MW Car Cleaning' },
  { url: 'https://www.4thgenhomeimprovement.com/', name: '4th Gen Home Improvement LLC' },
  { url: 'https://www.giovanaccipainting.com/', name: 'Giovanacci Painting' },
  { url: 'https://www.collierconstructiongroupltd.com/', name: 'Collier Construction Group' },
  { url: 'https://www.garciahandywork.com/', name: 'Garcia Handywork' },
  { url: 'https://www.steelasphaltcoatings.com/', name: 'Steel Asphalt Coatings' },
  { url: 'https://www.epiphanymedicalbillingllc.com/', name: 'Epiphany Medical Billing LLC' },
  { url: 'https://www.rodspaintinglv.com/', name: 'Rodspainting' },
  { url: 'https://www.homeworxalabama.com/', name: 'Homeworx' },
  { url: 'https://www.tablerockgrading.com/', name: 'Table Rock Grading and Construction' },
  { url: 'https://www.tpowerwash.com/', name: "T's Power Washing LLC" },
  { url: 'https://www.de-vils-parlor-ga.com/', name: "De Vil's Parlor" },
  { url: 'https://www.arkonoahpetsitting.com/', name: "Ark O' Noah Pet Sitting" },
  { url: 'https://www.apeppainting-nj.com/', name: 'APEP Painting' },
  { url: 'https://www.h2omarinetx.com/', name: 'H2O Marine Services' },
  { url: 'https://www.1touchcommunications-nextiva.com/', name: '1 Touch Communications' },
  { url: 'https://www.eaglesnesttownsend.com/', name: 'Eagles Nest' },
  { url: 'https://www.mambatraining.com/', name: 'Mamba training and Recovery' },
  { url: 'https://www.eugenepaintingco.com/', name: 'Eugene Painting Company' },
  { url: 'https://www.larosaremodelingllc.com/', name: 'La Rosa Remodeling LLC' },
  { url: 'https://www.m1concrete.com/', name: 'M1 Concrete' },
  { url: 'https://www.helpsaveourchildren.com/', name: 'Help Save Our Children Daycare' },
  { url: 'https://www.expertrepairsinstallations.com/', name: 'Expert Repairs Installations' },
  { url: 'https://www.jmotravelcafe.com/', name: 'JMO Travel Cafe' },
  { url: 'https://www.vicom-nextiva.com/', name: 'Vicom' },
  { url: 'https://www.thortechnologies-nextiva.com/', name: 'Thor Technologies' },
  { url: 'https://www.1calltechnologies-nextiva.com/', name: '1 Call Technologies' },
  { url: 'https://www.rescuecommunications-baptist-nextiva.com/', name: 'Rescue Communications' },
];

console.log(`Submitting ${sites.length} sites to migration worker...`);

const res = await fetch(`${PIXEL_URL}/api/migrate/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sites }),
});

const data = await res.json();
if (!res.ok) {
  console.error('Error:', res.status, JSON.stringify(data));
  process.exit(1);
}

console.log(`✅ Queued ${data.jobIds?.length ?? 0} jobs`);
console.log('Job IDs:', data.jobIds?.slice(0, 5).join(', '), '...');
console.log(`\nTrack progress at: ${PIXEL_URL}/dashboard/migrate`);
