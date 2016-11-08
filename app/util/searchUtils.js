import Relay from 'react-relay';

import get from 'lodash/get';
import take from 'lodash/take';
import orderBy from 'lodash/orderBy';
import sortBy from 'lodash/sortBy';
import debounce from 'lodash/debounce';
import flatten from 'lodash/flatten';

import config from '../config';

import { getJson } from './xhrPromise';
import routeCompare from './route-compare';
import { getLatLng } from './geo-utils';
import { uniqByLabel } from './suggestionUtils';

function getRelayQuery(query) {
  return new Promise((resolve, reject) => {
    const callback = readyState => {
      if (readyState.error) {
        reject(readyState.error);
      } else if (readyState.done) {
        resolve(Relay.Store.readQuery(query));
      }
    };

    Relay.Store.primeCache({ query }, callback);
  });
}

function mapRoutes(res) {
  return res.map(item =>
    ({
      type: 'Route',
      properties: {
        label: `${item.shortName} ${item.longName}`,
        layer: `route-${item.mode}`,
        mode: item.mode.toLowerCase(),
        agency: item.agency,
        shortName: item.shortName,
        longName: item.longName,
        link: `/linjat/${item.gtfsId}`,
      },
      geometry: {
        coordinates: [item.lat, item.lon],
      },
    })
  );
}

function mapStops(stops) {
  return stops.map(item => {
    const mode = item.routes
            && item.routes.length > 0
            ? item.routes[0].mode.toLowerCase()
            : null;

    const stop = {
      type: 'Stop',

      properties: {
        code: item.code,
        label: item.name,
        mode,
        layer: 'stop',
        link: `/pysakit/${item.gtfsId}`,
      },

      geometry: {
        coordinates: [item.lon, item.lat],
      },
    };

    if (item.code) {
      stop.properties.label = `${stop.properties.label}, ${item.code}`;
    }

    return stop;
  });
}


function filterMatchingToInput(list, input, fields) {
  if (typeof input === 'string' && input.length > 0) {
    return list.filter(item => {
      const parts = fields.map(pName => get(item, pName));

      const test = parts.join(' ').toLowerCase();
      return test.indexOf(input.toLowerCase()) > -1;
    });
  }

  return list;
}

function getCurrentPositionIfEmpty(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return Promise.resolve([{
      type: 'CurrentLocation',
      properties: { labelId: 'own-position', layer: 'currentPosition' },
    }]);
  }

  return Promise.resolve([]);
}

function getOldSearches(oldSearches, input) {
  const matchingOldSearches =
    filterMatchingToInput(oldSearches, input, ['address', 'locationName']);

  return Promise.resolve(take(matchingOldSearches, 10).map(item =>
    ({
      type: 'OldSearch',
      properties: {
        label: item.address,
        layer: 'oldSearch',
        mode: item.properties ? item.properties.mode : null },
      geometry: item.geometry,
    })
  ));
}

function getFavouriteLocations(favourites, input) {
  return Promise.resolve(
    orderBy(
      filterMatchingToInput(favourites, input, ['address', 'locationName']),
      feature => feature.locationName
    ).map(item =>
      ({
        type: 'Favourite',
        properties: { label: item.locationName, layer: 'favourite' },
        geometry: { type: 'Point', coordinates: [item.lon, item.lat] },
      })
  ));
}

function getGeocodingResult(input, geolocation, language) {
  // TODO: minimum length should be in config
  if (input === undefined || input === null || input.trim().length < 3) {
    return Promise.resolve([]);
  }

  const focusPoint = (config.autoSuggest.locationAware && geolocation.hasLocation) ? {
    'focus.point.lat': geolocation.lat, 'focus.point.lon': geolocation.lon,
  } : {};

  const opts = { text: input, ...config.searchParams, ...focusPoint, lang: language };

  return getJson(config.URL.PELIAS, opts)
    .then(res => orderBy(res.features, feature => feature.properties.confidence, 'desc'));
}

function getFavouriteRoutes(favourites, input) {
  const query = Relay.createQuery(Relay.QL`
    query favouriteRoutes($ids: [String!]!) {
      routes(ids: $ids ) {
        gtfsId
        agency { name }
        shortName
        mode
        longName
      }
    }`, { ids: favourites }
  );

  return getRelayQuery(query).then(favouriteRoutes =>
    filterMatchingToInput(
      mapRoutes(favouriteRoutes).map(favourite => ({
        ...favourite,
        properties: { ...favourite.properties, layer: 'favourite' },
        type: 'Favourite',
      })),
      input,
      ['properties.label', 'properties.code']
    ).sort((x, y) => routeCompare(x.properties, y.properties))
  );
}

function getRoutes(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return Promise.resolve([]);
  }
  const number = input.match(/^\d+$/);
  if (number && number[0].length > 3) {
    return Promise.resolve([]);
  }

  const query = Relay.createQuery(Relay.QL`
    query routes($name: String) {
      viewer {
        routes(name: $name ) {
          gtfsId
          agency {name}
          shortName
          mode
          longName
        }
      }
    }`, { name: input }
  );

  return getRelayQuery(query).then(data =>
    mapRoutes(data[0].routes).sort((x, y) => routeCompare(x.properties, y.properties))
  ).then(suggestions => take(suggestions, 10));
}

function getStops(input, origin) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return Promise.resolve([]);
  }
  const number = input.match(/^\d+$/);
  if (number && number[0].length !== 4) {
    return Promise.resolve([]);
  }

  const query = Relay.createQuery(Relay.QL`
    query stops($name: String) {
      viewer {
        stops(name: $name ) {
          gtfsId
          lat
          lon
          name
          code
          routes { mode }
        }
      }
    }`, { name: input }
  );

  const refLatLng = origin.lat && origin.lon && getLatLng(origin.lat, origin.lon);

  return getRelayQuery(query).then(data => mapStops(data[0].stops)).then(stops => (
    refLatLng ?
    sortBy(stops, (item) =>
      Math.round(
        getLatLng(item.geometry.coordinates[1], item.geometry.coordinates[0])
        .distanceTo(refLatLng) / 50000) // divide in 50km buckets
    ) : stops
  )).then(suggestions => take(suggestions, 10));
}

export function executeSearchPromise(getStore, { input, type }, callback) {
  const position = getStore('PositionStore').getLocationState();
  let endpoitSearches = [];
  let searchSearches = [];

  if (type === 'endpoint' || type === 'all') {
    const favouriteLocations = getStore('FavouriteLocationStore').getLocations();
    const oldSearches = getStore('OldSearchesStore').getOldSearches('endpoint');
    const language = getStore('PreferencesStore').getLanguage();

    endpoitSearches = Promise.all([
      getCurrentPositionIfEmpty(input),
      getFavouriteLocations(favouriteLocations, input),
      getOldSearches(oldSearches, input),
      getGeocodingResult(input, position, language),
    ])
    .then(flatten)
    .then(uniqByLabel)
    .catch(err => console.error(err)); // eslint-disable-line no-console

    if (type === 'endpoint') {
      if (typeof callback !== 'function') {
        return endpoitSearches;
      }
      return endpoitSearches.then(callback);
    }
  }

  if (type === 'search' || type === 'all') {
    const origin = getStore('EndpointStore').getOrigin();
    const location = origin.lat ? origin : position;
    const favouriteRoutes = getStore('FavouriteRoutesStore').getRoutes();

    searchSearches = Promise.all([
      getFavouriteRoutes(favouriteRoutes, input),
      getRoutes(input),
      getStops(input, location),
    ])
    .then(flatten)
    .then(uniqByLabel)
    .catch(err => console.error(err)); // eslint-disable-line no-console

    if (type === 'search') {
      if (typeof callback !== 'function') {
        return searchSearches;
      }
      return searchSearches.then(callback);
    }
  }

  if (typeof callback !== 'function') {
    return Promise.all([endpoitSearches, searchSearches]).then(([endpoints, search]) => ([
      { name: 'endpoint', items: endpoints },
      { name: 'search', items: search },
    ]));
  }
  return Promise.all([endpoitSearches, searchSearches])
    .then(([endpoints, search]) => callback([
      { name: 'endpoint', items: endpoints },
      { name: 'search', items: search },
    ]))
    .catch(err => console.error(err)); // eslint-disable-line no-console
}

const debouncedSearch = debounce(executeSearchPromise, 300);

export const executeSearch = (getStore, data, callback) => {
  callback([]);
  debouncedSearch(getStore, data, callback);
};
