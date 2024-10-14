const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const fetch = require('node-fetch');
const ObjectsToCsv = require('objects-to-csv');
const axios = require('axios');

// URL til CSV fra Google Sheets
const csvUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRVRzQdPegvGFlgxs55vjD9VCNYjn83TrQ_yZy9F9TXhdbQLzdx14rzEvve-s_zfBo3wrR7Gp4pngAz/pub?output=csv';

// Funktion til at hente CSV data
async function fetchCSV(url) {
    const response = await fetch(url);
    const csvData = [];
    return new Promise((resolve, reject) => {
        response.body
            .pipe(csv())
            .on('data', (row) => csvData.push(row))
            .on('end', () => resolve(csvData))
            .on('error', reject);
    });
}

// Funktion til at gemme billeder
async function saveImage(url, ean) {
    const dir = './images';

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }

    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data, 'binary');
    fs.writeFileSync(path.join(dir, `${ean}.jpg`), buffer);
    console.log(`Billede gemt som ${ean}.jpg`);
}

// Funktion til at vente
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Funktion til at hente EAN kode og billeder via puppeteer
async function getEANAndImage(artikelNummer, browser) {
    const page = await browser.newPage();
    const maxRetries = 3; // Maximum retries
    let attempt = 0;
    let ean = null;

    const searchUrl = `https://www.dovgan.de/search?query=${artikelNummer}`;

    while (attempt < maxRetries) {
        try {
            await page.goto(searchUrl, { waitUntil: 'networkidle0', timeout: 300000 }); // 5 minutter

            await page.waitForSelector('.msmcd-img', { timeout: 5000 });
            let productLink = await page.$eval('.msmcd-img', el => el.closest('a').getAttribute('href'));

            if (!productLink.startsWith('/')) {
                productLink = `/${productLink}`;
            }
            const fullProductLink = `https://www.dovgan.de${productLink}`;

            // Gå til produktlinket
            await page.goto(fullProductLink, { waitUntil: 'networkidle0', timeout: 300000 }); // 5 minutter
            await wait(2000); // Vent 2 sekunder

            // Hent EAN
            await page.waitForSelector('.form-control-static', { timeout: 5000 });
            ean = await page.evaluate(() => {
                const eanLabel = Array.from(document.querySelectorAll('.form-group'))
                    .find(group => group.innerText.includes('EAN:'));
                return eanLabel ? eanLabel.querySelector('.form-control-static').innerText : null;
            });

            // Hent billede URL
            const imageUrl = await page.evaluate(() => {
                const imgElement = document.querySelector('.fotorama__img');
                return imgElement ? imgElement.src : null;
            });

            if (ean && imageUrl) {
                console.log(`Henter billede for EAN: ${ean}`);
                await saveImage(imageUrl, ean);
                return ean;
            } else {
                console.error("EAN eller billede URL ikke fundet.");
                return null;
            }

        } catch (error) {
            console.error("Error encountered on attempt:", attempt + 1, error);
            attempt++;
            if (attempt < maxRetries) {
                console.log("Retrying...");
                await wait(3000); // Vent 3 sekunder mellem forsøg
            } else {
                console.error("Max retries reached. Unable to get EAN for:", artikelNummer);
                return null; // Return null hvis alle forsøg fejler
            }
        }
    }

    await page.close(); // Luk siden, når vi er færdige med at hente data
}

// Funktion til at opdatere CSV-filen med EAN-koder i Ark2
async function updateCSV() {
    const csvData = await fetchCSV(csvUrl);
    const browser = await puppeteer.launch({ headless: false });

    const updatedData = [];
    const promises = [];

    for (let row of csvData) {
        if (row['Art.-NR']) {
            promises.push(getEANAndImage(row['Art.-NR'], browser).then(ean => {
                row['Stregkode'] = ean || 'Ikke fundet';
                console.log(`Opdaterer række med artikelnummer: ${row['Art.-NR']}, EAN: ${ean}`);
            }));
        }
        updatedData.push(row);
    }

    await Promise.all(promises);

    const csvInstance = new ObjectsToCsv(updatedData);
    await csvInstance.toDisk('./opdateret_ark2.csv');
    console.log('Opdateret CSV fil for Ark2 er gemt som opdateret_ark2.csv');

    await browser.close();
}

// Kør opdateringsfunktionen
updateCSV().catch(console.error);
