async function sendTelegramNotification({
    axios,
    FormData,
    fs,
    token,
    chatId,
    message,
    imagePath,
    logger = console
}) {
    const result = { skipped: false, textSent: false, imageSent: false };
    if (!token || !chatId) return { ...result, skipped: true };

    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message
        }, { timeout: 10000 });
        result.textSent = true;
    } catch (error) {
        logger.error('[Telegram] text notification failed:', error.code || 'request_error');
    }

    if (imagePath && fs.existsSync(imagePath)) {
        try {
            const form = new FormData();
            form.append('chat_id', chatId);
            form.append('photo', fs.createReadStream(imagePath));
            await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, form, {
                headers: form.getHeaders(),
                timeout: 15000,
                maxBodyLength: Infinity
            });
            result.imageSent = true;
        } catch (error) {
            logger.error('[Telegram] image notification failed:', error.code || 'request_error');
        }
    }

    return result;
}

module.exports = { sendTelegramNotification };
