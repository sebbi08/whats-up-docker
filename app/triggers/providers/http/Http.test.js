const { ValidationError } = require('joi');
const rp = require('request-promise-native');

jest.mock('request-promise-native');
const Http = require('./Http');

const http = new Http();

const configurationValid = {
    url: 'http://xxx.com',
    method: 'POST',
};

beforeEach(() => {
    jest.resetAllMocks();
});

test('validateConfiguration should return validated configuration when valid', () => {
    const validatedConfiguration = http.validateConfiguration(configurationValid);
    expect(validatedConfiguration).toStrictEqual(configurationValid);
});

test('validateConfiguration should apply_default_configuration', () => {
    const validatedConfiguration = http.validateConfiguration({
        url: configurationValid.url,
    });
    expect(validatedConfiguration).toStrictEqual(configurationValid);
});

test('validateConfiguration should throw error when invalid', () => {
    const configuration = {
        url: 'git://xxx.com',
    };
    expect(() => {
        http.validateConfiguration(configuration);
    }).toThrowError(ValidationError);
});

test('notify should send POST http request when configured like that', async () => {
    http.configuration = {
        method: 'POST',
        url: 'https:///test',
    };
    const container = {
        name: 'container1',
    };
    await http.notify(container);
    expect(rp).toHaveBeenCalledWith({
        body: {
            name: 'container1',
        },
        json: true,
        method: 'POST',
        uri: 'https:///test',
    });
});

test('notify should send GET http request when configured like that', async () => {
    http.configuration = {
        method: 'GET',
        url: 'https:///test',
    };
    const container = {
        name: 'container1',
    };
    await http.notify(container);
    expect(rp).toHaveBeenCalledWith({
        qs: {
            name: 'container1',
        },
        method: 'GET',
        uri: 'https:///test',
    });
});
