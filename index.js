require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

if (!process.env.BOT_TOKEN) {
    console.error('❌ Ошибка: BOT_TOKEN не найден в файле .env');
    process.exit(1);
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_DIR = './storage';

if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

const db = new sqlite3.Database('storage.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        original_name TEXT NOT NULL,
        custom_name TEXT,
        category TEXT NOT NULL,
        file_type TEXT NOT NULL,
        user_id INTEGER,
        username TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`ALTER TABLE files ADD COLUMN custom_name TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.log('Колонка custom_name уже существует');
        }
    });
    
    db.run(`CREATE TABLE IF NOT EXISTS text_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        user_id INTEGER,
        username TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

const bot = new Telegraf(BOT_TOKEN);

// Хранилища
const userStates = new Map();
const userLastMessages = new Map();

const CATEGORIES = ['📁 Документы', '📁 Прочее', '🎵 Медиа', '💻 Архивы', '📝 Заметки'];

// Клавиатура меню (всегда видна)
const mainKeyboard = Markup.keyboard([
    ['📤 Загрузить файл', '✏️ Создать текст'],
    ['📂 Мои файлы', '📋 Все файлы'],
    ['📝 Все заметки', '🔍 Поиск'],
    ['📊 Статистика']
]).resize();

// Inline клавиатура для выбора категории
const getCategoryKeyboard = () => {
    const buttons = CATEGORIES.map(cat => [Markup.button.callback(cat, `cat_${cat}`)]);
    buttons.push([Markup.button.callback('❌ Отмена', 'cancel')]);
    return Markup.inlineKeyboard(buttons);
};

// Функция для отправки нового сообщения (всегда внизу)
async function sendNewMessage(ctx, text, inlineKeyboard = null) {
    const userId = ctx.from.id;
    const lastMessageId = userLastMessages.get(userId);
    
    if (lastMessageId) {
        try {
            await ctx.telegram.deleteMessage(ctx.chat.id, lastMessageId);
        } catch (error) {}
    }
    
    let msg;
    if (inlineKeyboard) {
        msg = await ctx.reply(text, {
            parse_mode: 'Markdown',
            ...inlineKeyboard
        });
    } else {
        msg = await ctx.reply(text, { parse_mode: 'Markdown' });
    }
    
    userLastMessages.set(userId, msg.message_id);
    return msg;
}

// Сохранение файла с пользовательским названием
async function saveFile(ctx, fileId, originalName, customName, category, fileType) {
    try {
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const extension = path.extname(originalName);
        const uniqueName = `${Date.now()}_${Math.random().toString(36).substring(7)}${extension}`;
        const filePath = path.join(STORAGE_DIR, uniqueName);
        
        const response = await fetch(fileLink.href);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        
        const finalName = customName && customName !== 'нет' && customName !== 'no' ? customName : null;
        
        return new Promise((resolve) => {
            db.run(
                `INSERT INTO files (file_path, original_name, custom_name, category, file_type, user_id, username)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [filePath, originalName, finalName, category, fileType, ctx.from.id, ctx.from.username || ctx.from.first_name],
                (err) => {
                    if (err) {
                        resolve({ success: false, error: err.message });
                    } else {
                        resolve({ success: true, name: finalName || originalName });
                    }
                }
            );
        });
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Удаление файла
async function deleteFile(fileId, userId) {
    return new Promise((resolve) => {
        db.get('SELECT * FROM files WHERE id = ? AND user_id = ?', [fileId, userId], (err, file) => {
            if (err || !file) {
                resolve({ success: false, error: 'Файл не найден или не принадлежит вам' });
                return;
            }
            
            if (fs.existsSync(file.file_path)) {
                fs.unlinkSync(file.file_path);
            }
            
            db.run('DELETE FROM files WHERE id = ? AND user_id = ?', [fileId, userId], (err) => {
                if (err) {
                    resolve({ success: false, error: err.message });
                } else {
                    resolve({ success: true });
                }
            });
        });
    });
}

// Сохранение заметки
async function saveNote(ctx, title, content) {
    return new Promise((resolve) => {
        db.run(
            `INSERT INTO text_notes (title, content, category, user_id, username)
             VALUES (?, ?, ?, ?, ?)`,
            [title, content, '📝 Заметки', ctx.from.id, ctx.from.username || ctx.from.first_name],
            () => resolve()
        );
    });
}

// Удаление заметки
async function deleteNote(noteId, userId) {
    return new Promise((resolve) => {
        db.run('DELETE FROM text_notes WHERE id = ? AND user_id = ?', [noteId, userId], (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
            } else {
                resolve({ success: true });
            }
        });
    });
}

// Получить заметку по ID
async function getNoteById(noteId) {
    return new Promise((resolve) => {
        db.get('SELECT * FROM text_notes WHERE id = ?', [noteId], (err, row) => {
            resolve(row);
        });
    });
}

// Показать заметку полностью
async function showFullNote(ctx, noteId) {
    const note = await getNoteById(noteId);
    if (!note) {
        await sendNewMessage(ctx, '❌ Заметка не найдена');
        return;
    }
    
    const text = `📝 *${note.title}*\n\n📁 ${note.category}\n👤 ${note.username || `ID${note.user_id}`}\n📅 ${new Date(note.created_at).toLocaleString()}\n\n📄 *Текст заметки:*\n${note.content}`;
    
    const buttons = [
        [Markup.button.callback('🗑️ Удалить заметку', `delete_note_${note.id}`)]
    ];
    
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// Показать главное меню
async function showMainMenu(ctx) {
    const text = `👋 Привет, ${ctx.from.first_name}!

📚 *Общее хранилище файлов*

📎 Загружай файлы (txt, zip, rar)
✏️ Создавай текстовые заметки
📥 Скачивай файлы других пользователей
🗑️ Удаляй свои файлы и заметки

Используй кнопки ниже:`;
    
    await sendNewMessage(ctx, text);
}

// Показать мои файлы
async function showMyFiles(ctx) {
    const userId = ctx.from.id;
    
    const files = await new Promise(resolve => {
        db.all('SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    const notes = await new Promise(resolve => {
        db.all('SELECT * FROM text_notes WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    if (files.length === 0 && notes.length === 0) {
        await sendNewMessage(ctx, '📭 У вас пока нет сохранённых файлов или заметок.');
        return;
    }
    
    let text = '📂 *Ваши файлы и заметки*\n\n';
    const buttons = [];
    
    // Заметки
    if (notes.length > 0) {
        text += '✏️ *Заметки:*\n\n';
        notes.forEach(note => {
            const shortTitle = note.title.length > 30 ? note.title.substring(0, 30) + '...' : note.title;
            text += `📝 *${note.title}*\n📅 ${new Date(note.created_at).toLocaleDateString()}\n\n`;
            buttons.push([Markup.button.callback(`📖 Просмотреть "${shortTitle}"`, `view_note_${note.id}`)]);
        });
        text += '\n';
    }
    
    // Файлы
    if (files.length > 0) {
        text += '📎 *Файлы:*\n\n';
        files.forEach(file => {
            const displayName = file.custom_name || file.original_name;
            const shortName = displayName.length > 25 ? displayName.substring(0, 25) + '...' : displayName;
            text += `📄 ${displayName}\n📁 ${file.category}\n📅 ${new Date(file.created_at).toLocaleDateString()}\n\n`;
            buttons.push([
                Markup.button.callback(`📥 ${shortName}`, `download_${file.id}`),
                Markup.button.callback(`🗑️ ${shortName}`, `delete_file_${file.id}`)
            ]);
        });
    }
    
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// Показать все файлы
async function showAllFiles(ctx) {
    const files = await new Promise(resolve => {
        db.all('SELECT * FROM files ORDER BY created_at DESC LIMIT 30', [], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    if (files.length === 0) {
        await sendNewMessage(ctx, '📭 Пока нет ни одного файла в хранилище.');
        return;
    }
    
    let text = '📋 *Все файлы в хранилище:*\n\n';
    const buttons = [];
    
    files.forEach(file => {
        const displayName = file.custom_name || file.original_name;
        const shortName = displayName.length > 25 ? displayName.substring(0, 25) + '...' : displayName;
        text += `📄 *${displayName}*\n📁 ${file.category}\n👤 ${file.username || `ID${file.user_id}`}\n📅 ${new Date(file.created_at).toLocaleString()}\n\n`;
        buttons.push([Markup.button.callback(`📥 ${shortName}`, `download_${file.id}`)]);
    });
    
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// Показать все заметки
async function showAllNotes(ctx) {
    const notes = await new Promise(resolve => {
        db.all('SELECT * FROM text_notes ORDER BY created_at DESC LIMIT 30', [], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    if (notes.length === 0) {
        await sendNewMessage(ctx, '📭 Пока нет ни одной заметки.');
        return;
    }
    
    let text = '📝 *Все заметки пользователей:*\n\n';
    const buttons = [];
    
    notes.forEach(note => {
        const shortTitle = note.title.length > 30 ? note.title.substring(0, 30) + '...' : note.title;
        text += `📝 *${note.title}*\n👤 ${note.username || `ID${note.user_id}`}\n📅 ${new Date(note.created_at).toLocaleDateString()}\n\n`;
        buttons.push([Markup.button.callback(`📖 Читать "${shortTitle}"`, `view_note_${note.id}`)]);
    });
    
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// Показать статистику
async function showStats(ctx) {
    const totalFiles = await new Promise(resolve => {
        db.get('SELECT COUNT(*) as count FROM files', [], (err, row) => {
            resolve(row ? row.count : 0);
        });
    });
    
    const totalNotes = await new Promise(resolve => {
        db.get('SELECT COUNT(*) as count FROM text_notes', [], (err, row) => {
            resolve(row ? row.count : 0);
        });
    });
    
    const totalUsers = await new Promise(resolve => {
        db.get(`SELECT COUNT(DISTINCT user_id) as count FROM 
                (SELECT user_id FROM files UNION SELECT user_id FROM text_notes)`, [], (err, row) => {
            resolve(row ? row.count : 0);
        });
    });
    
    const categoryStats = await new Promise(resolve => {
        db.all('SELECT category, COUNT(*) as count FROM files GROUP BY category', [], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    let catMsg = '';
    categoryStats.forEach(stat => {
        catMsg += `${stat.category === '📝 Заметки' ? '📝' : '📄'} ${stat.category}: ${stat.count}\n`;
    });
    
    const text = `📊 *Статистика хранилища*\n\n` +
        `📄 Файлов: ${totalFiles}\n` +
        `✏️ Заметок: ${totalNotes}\n` +
        `👥 Пользователей: ${totalUsers}\n\n` +
        `*По категориям:*\n${catMsg || 'Нет файлов'}`;
    
    await sendNewMessage(ctx, text);
}

// Поиск
async function handleSearch(ctx, query) {
    const files = await new Promise(resolve => {
        db.all('SELECT * FROM files WHERE original_name LIKE ? OR custom_name LIKE ? LIMIT 10', [`%${query}%`, `%${query}%`], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    const notes = await new Promise(resolve => {
        db.all('SELECT * FROM text_notes WHERE title LIKE ? OR content LIKE ? LIMIT 10', [`%${query}%`, `%${query}%`], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    if (files.length === 0 && notes.length === 0) {
        await sendNewMessage(ctx, '❌ Ничего не найдено');
        return;
    }
    
    let text = `🔍 Результаты поиска: "${query}"\n\n`;
    const buttons = [];
    
    if (notes.length > 0) {
        text += '✏️ *Заметки:*\n\n';
        notes.forEach(n => {
            text += `📝 ${n.title}\n👤 ${n.username || `ID${n.user_id}`}\n\n`;
            buttons.push([Markup.button.callback(`📖 Читать "${n.title.substring(0, 20)}"`, `view_note_${n.id}`)]);
        });
        text += '\n';
    }
    
    if (files.length > 0) {
        text += '📎 *Файлы:*\n\n';
        files.forEach(file => {
            const displayName = file.custom_name || file.original_name;
            text += `📄 ${displayName} (${file.category})\n👤 ${file.username || `ID${file.user_id}`}\n\n`;
            buttons.push([Markup.button.callback(`📥 Скачать ${displayName.substring(0, 20)}`, `download_${file.id}`)]);
        });
    }
    
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// ========== КОМАНДЫ ==========
bot.start(async (ctx) => {
    userStates.delete(ctx.from.id);
    userLastMessages.delete(ctx.from.id);
    await ctx.reply(`👋 Привет, ${ctx.from.first_name}! Бот запущен. Используй кнопки ниже.`, mainKeyboard);
    await showMainMenu(ctx);
});

// ========== ГЛАВНЫЕ КНОПКИ МЕНЮ ==========
bot.hears('📤 Загрузить файл', async (ctx) => {
    userStates.set(ctx.from.id, { action: 'waiting_for_file_name' });
    await sendNewMessage(ctx, '📎 Отправьте файл (txt, zip, rar):\n\nСначала отправьте файл, потом я спрошу название.');
});

bot.hears('✏️ Создать текст', async (ctx) => {
    userStates.set(ctx.from.id, { action: 'waiting_for_note' });
    await sendNewMessage(ctx, '📝 Отправьте текст в формате:\n\n`Название\nТекст заметки`\n\nЗаметка сохранится в категорию "📝 Заметки"');
});

bot.hears('📂 Мои файлы', async (ctx) => {
    await showMyFiles(ctx);
});

bot.hears('📋 Все файлы', async (ctx) => {
    await showAllFiles(ctx);
});

bot.hears('📝 Все заметки', async (ctx) => {
    await showAllNotes(ctx);
});

bot.hears('🔍 Поиск', async (ctx) => {
    userStates.set(ctx.from.id, { action: 'search' });
    await sendNewMessage(ctx, '🔎 Введите текст для поиска (или "отмена"):');
});

bot.hears('📊 Статистика', async (ctx) => {
    await showStats(ctx);
});

// ========== ПРОСМОТР ЗАМЕТОК ==========
bot.action(/view_note_(\d+)/, async (ctx) => {
    const noteId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    await showFullNote(ctx, noteId);
});

// ========== CALLBACK ОБРАБОТЧИКИ ==========

// Выбор категории
bot.action(/cat_(.+)/, async (ctx) => {
    const category = ctx.match[1];
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    
    await ctx.answerCbQuery();
    
    if (state && state.pendingFile) {
        const customName = state.customName;
        const result = await saveFile(ctx, state.fileId, state.fileName, customName, category, state.fileType);
        
        if (result.success) {
            await sendNewMessage(ctx, `✅ Файл "${result.name}" сохранён в категорию ${category}!`);
        } else {
            await sendNewMessage(ctx, `❌ Ошибка: ${result.error}`);
        }
        
        userStates.delete(userId);
    } else {
        await sendNewMessage(ctx, '❌ Действие отменено');
        userStates.delete(userId);
    }
});

// Отмена
bot.action('cancel', async (ctx) => {
    await ctx.answerCbQuery('Отменено');
    userStates.delete(ctx.from.id);
    await showMainMenu(ctx);
});

// Скачивание файла
bot.action(/download_(\d+)/, async (ctx) => {
    const fileId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery('⏳ Загружаю...');
    
    const file = await new Promise(resolve => {
        db.get('SELECT * FROM files WHERE id = ?', [fileId], (err, row) => {
            resolve(row);
        });
    });
    
    if (!file) {
        await ctx.reply('❌ Файл не найден');
        return;
    }
    
    if (!fs.existsSync(file.file_path)) {
        await ctx.reply('❌ Файл удалён с сервера');
        return;
    }
    
    const displayName = file.custom_name || file.original_name;
    
    await ctx.replyWithDocument(
        { source: file.file_path },
        {
            caption: `📄 *${displayName}*\n📁 ${file.category}\n👤 ${file.username || `ID${file.user_id}`}\n📅 ${new Date(file.created_at).toLocaleString()}`,
            parse_mode: 'Markdown'
        }
    );
});

// Удаление файла
bot.action(/delete_file_(\d+)/, async (ctx) => {
    const fileId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;
    
    await ctx.answerCbQuery('⏳ Удаляю...');
    
    const result = await deleteFile(fileId, userId);
    
    if (result.success) {
        await showMyFiles(ctx);
    } else {
        await sendNewMessage(ctx, `❌ Ошибка: ${result.error}`);
    }
});

// Удаление заметки
bot.action(/delete_note_(\d+)/, async (ctx) => {
    const noteId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;
    
    await ctx.answerCbQuery('⏳ Удаляю...');
    
    const result = await deleteNote(noteId, userId);
    
    if (result.success) {
        await showMyFiles(ctx);
    } else {
        await sendNewMessage(ctx, `❌ Ошибка: ${result.error}`);
    }
});

// ========== ОБРАБОТКА ФАЙЛОВ ==========
bot.on('document', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    
    if (!state || state.action !== 'waiting_for_file_name') {
        await sendNewMessage(ctx, '⚠️ Сначала нажмите кнопку "📤 Загрузить файл"');
        return;
    }
    
    const doc = ctx.message.document;
    const fileName = doc.file_name;
    const ext = path.extname(fileName).toLowerCase();
    
    if (!['.txt', '.zip', '.rar'].includes(ext)) {
        await sendNewMessage(ctx, '❌ Разрешены только: txt, zip, rar');
        return;
    }
    
    userStates.set(userId, {
        action: 'waiting_for_custom_name',
        fileId: doc.file_id,
        fileName: fileName,
        fileType: ext.substring(1),
        originalName: fileName
    });
    
    await sendNewMessage(ctx, `📁 Файл "${fileName}" получен!\n\nВведите название для файла (или отправьте "нет" для использования оригинального названия):`);
});

// ========== ОБРАБОТКА ТЕКСТА ==========
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    const text = ctx.message.text;
    
    const menuButtons = ['📤 Загрузить файл', '✏️ Создать текст', '📂 Мои файлы', '📋 Все файлы', '📝 Все заметки', '🔍 Поиск', '📊 Статистика'];
    if (menuButtons.includes(text)) return;
    
    // Обработка названия для файла
    if (state && state.action === 'waiting_for_custom_name') {
        let customName = null;
        if (text.toLowerCase() !== 'нет' && text.toLowerCase() !== 'no') {
            customName = text;
        }
        
        userStates.set(userId, {
            action: 'select_category',
            pendingFile: true,
            fileId: state.fileId,
            fileName: state.fileName,
            customName: customName,
            fileType: state.fileType
        });
        
        await sendNewMessage(ctx, `📁 Название: ${customName || state.fileName}\n\nТеперь выберите категорию:`, getCategoryKeyboard());
        return;
    }
    
    // Создание заметки
    if (state && state.action === 'waiting_for_note') {
        const lines = text.trim().split('\n');
        
        if (lines.length < 2) {
            await sendNewMessage(ctx, '❌ Неверный формат. Нужно:\n\n`Название\nТекст`');
            return;
        }
        
        const title = lines[0].trim();
        const content = lines.slice(1).join('\n').trim();
        
        if (!title) {
            await sendNewMessage(ctx, '❌ Название не может быть пустым');
            return;
        }
        
        await saveNote(ctx, title, content);
        await sendNewMessage(ctx, `✅ Заметка "${title}" сохранена!`);
        userStates.delete(userId);
        return;
    }
    
    // Поиск
    if (state && state.action === 'search') {
        if (text.toLowerCase() === 'отмена') {
            userStates.delete(userId);
            await showMainMenu(ctx);
            return;
        }
        
        await handleSearch(ctx, text);
        userStates.delete(userId);
        return;
    }
});

// ========== ЗАПУСК ==========
bot.launch().then(() => {
    console.log('\n✅ Бот успешно запущен!');
    console.log('💡 Бот готов к работе!\n');
});

process.once('SIGINT', () => {
    bot.stop('SIGINT');
    process.exit(0);
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    process.exit(0);
});