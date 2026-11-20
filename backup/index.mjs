import path from 'node:path';
import { getJournalFiles, getJournalEntries, readJournalFile } from './journals.mjs';

const defaultJournalDirPath = path.join(process.env.USERPROFILE, 'Saved Games/Frontier Developments/Elite Dangerous');
const journalDirPath = defaultJournalDirPath;

let journalFileList;
try {
  journalFileList = await getJournalFiles(journalDirPath, 100);
} catch (error) {
  console.log(`Error reading journal directory "${journalDirPath}":`, error);
}
if (!journalFileList) {
  console.log('No journal files to process!');
  process.exit(0);
}

const allJournalFileEntries = await getJournalEntries(journalFileList);
const allCommanderNames = Object.keys(allJournalFileEntries);
console.log(`Journal entries found for commander(s): ${allCommanderNames.join(', ')}`);

// TODO: ignore carrier signals if I didn't interact with them (swap the search order?)
// TODO: find better way to get market ID
// TODO: determine if market ID is per-system!
const fleetCarriers = {};
for (const commander of allCommanderNames) {
  const journals = allJournalFileEntries[commander];
  const fssCarrierSignalEntries = journals.filter(e => e.event === 'FSSSignalDiscovered' && e.SignalType === 'FleetCarrier');
  const fssCarriers = fssCarrierSignalEntries.map(s => {
    const name = s.SignalName.substring(0, s.SignalName.length - 7).trim();
    const id = s.SignalName.substring(s.SignalName.length - 7);
    const marketId = Object.keys(fleetCarriers).includes(id) && fleetCarriers[id].marketId
      ? fleetCarriers[id].marketId
      : journals.find(e => e.event === 'SupercruiseDestinationDrop' && e.Type === s.SignalName)?.MarketID;
    return { name, id, marketId };
  });
  for (const carrier of fssCarriers) {
    fleetCarriers[carrier.id] = {
      name: carrier.name,
      marketId: carrier.marketId
    };
  }
}

// Find all carrier fuel deposits
// TODO: go through jornals in order to determine system?
const carrierFuelDeposits = {};
for (const commander of allCommanderNames) {
  carrierFuelDeposits[commander] = [];
  const journals = allJournalFileEntries[commander];
  const carrierFuelDepositEntries = journals.filter(e => e.event === 'CarrierDepositFuel');
  for (const carrierFuelDepositEntry of carrierFuelDepositEntries) {
    carrierFuelDeposits[commander].push({
      timestamp: carrierFuelDepositEntry.timestamp,
      carrierId: Object.keys(fleetCarriers).find(fcid => fleetCarriers[fcid].marketId === carrierFuelDepositEntry.CarrierID),
      amount: carrierFuelDepositEntry.Amount,
      total: carrierFuelDepositEntry.Total
    });
  }

  if (!carrierFuelDeposits[commander].filter(d => d.carrierId).length) continue;
  console.log(`\nCarrier Fuel Deposits For: ${commander}`);
  console.log('Timestamp,Carrier ID,Carrier Name,Amount,Total');
  console.log(carrierFuelDeposits[commander].filter(d => d.carrierId).map(deposit => {
    return `${deposit.timestamp},${deposit.carrierId},${fleetCarriers[deposit.carrierId]?.name},${deposit.amount},${deposit.total}`;
  }).join('\n'));
}
