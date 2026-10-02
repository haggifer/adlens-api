import { ResendMailer } from './mailer'

const MESSAGE = { to: 'team@adlens.test', subject: 'Hello', text: 'Hello', html: '<p>Hello</p>' }

describe('ResendMailer', () => {
    const fetchMock = jest.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }))

    beforeAll(() => {
        jest.spyOn(global, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch)
    })

    beforeEach(() => {
        fetchMock.mockClear()
    })

    afterAll(() => {
        jest.restoreAllMocks()
    })

    const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0][1].body))

    it('sends attachments base64-encoded with their file names', async () => {
        await new ResendMailer('key', 'AdLens <hello@mail.adlens.test>').send({
            ...MESSAGE,
            attachments: [{ filename: 'shot.png', content: Buffer.from('png bytes') }],
        })

        expect(sentBody().attachments).toEqual([
            { filename: 'shot.png', content: Buffer.from('png bytes').toString('base64') },
        ])
    })

    it('sends no attachments field without attachments', async () => {
        await new ResendMailer('key', 'AdLens <hello@mail.adlens.test>').send(MESSAGE)

        expect(sentBody()).not.toHaveProperty('attachments')
    })

    it("reports a refusal by its status alone, since Resend's body can quote the recipient", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response('{"message":"Invalid `to` field: team@adlens.test"}', { status: 422 }),
        )

        await expect(new ResendMailer('key', 'AdLens <hello@mail.adlens.test>').send(MESSAGE)).rejects.toThrow(
            /^Resend responded 422$/,
        )
    })
})
