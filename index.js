require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

console.log('🚀 НАЧАЛО ЗАГРУЗКИ БОТА');

// ========== ПРОВЕРКА ТОКЕНА ==========
if (!process.env.BOT_TOKEN) {
    console.error('❌ Ошибка: BOT_TOKEN не найден в файле .env');
    process.exit(1);
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_DIR = './storage';

if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// ========== ПЕРЕСОЗДАНИЕ ТАБЛИЦЫ С ПРАВИЛЬНОЙ СТРУКТУРОЙ ==========
console.log('🗄️ Настройка базы данных...');

// Удаляем старую таблицу если она есть с неправильной структурой
const db = new sqlite3.Database('storage.db');

db.serialize(() => {
    // Проверяем структуру и пересоздаём если нужно
    db.run("DROP TABLE IF EXISTS files_old");
    db.run("ALTER TABLE files RENAME TO files_old", (err) => {
        // Если таблицы не было, ошибка игнорируется
    });
    
    // Создаём новую таблицу с правильной структурой
    db.run(`CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_name TEXT NOT NULL,
        custom_name TEXT,
        category TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_path TEXT,
        drive_link TEXT,
        drive_file_id TEXT,
        user_id INTEGER,
        username TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы:', err);
        } else {
            console.log('✅ Таблица files создана');
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
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы text_notes:', err);
        } else {
            console.log('✅ Таблица text_notes создана');
        }
    });
    
    // Восстанавливаем данные из старой таблицы если есть
    db.run(`INSERT INTO files (original_name, custom_name, category, file_type, user_id, username, created_at)
            SELECT original_name, custom_name, category, file_type, user_id, username, created_at 
            FROM files_old WHERE original_name IS NOT NULL`, (err) => {
        if (err && !err.message.includes('no such table')) {
            console.log('⚠️ Не удалось восстановить данные:', err.message);
        } else if (!err) {
            console.log('✅ Данные восстановлены');
        }
        db.run("DROP TABLE IF EXISTS files_old");
    });
});

// Немного ждём создания таблиц
setTimeout(() => {
    console.log('✅ База данных готова');
}, 500);

// ========== ИНИЦИАЛИЗАЦИЯ БОТА ==========
const bot = new Telegraf(BOT_TOKEN);

// Хранилища
const userStates = new Map();
const userLastMessages = new Map();

const CATEGORIES = ['📁 Документы', '📁 Прочее', '🎵 Медиа', '💻 Архивы', '📝 Заметки'];
const ALLOWED_EXTENSIONS = ['.txt', '.zip', '.rar', '.pdf', '.docx', '.jpg', '.jpeg', '.png', '.mp4', '.mp3'];

// ========== КЛАВИАТУРЫ ==========
const getMainMenuKeyboard = () => {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📤 Загрузить файл', 'menu_upload')],
        [Markup.button.callback('🔗 Добавить ссылку', 'menu_add_link')],
        [Markup.button.callback('✏️ Создать текст', 'menu_create_note')],
        [Markup.button.callback('📂 Мои файлы', 'menu_my_files')],
        [Markup.button.callback('📋 Все файлы', 'menu_all_files')],
        [Markup.button.callback('📝 Все заметки', 'menu_all_notes')],
        [Markup.button.callback('🔍 Поиск', 'menu_search')],
        [Markup.button.callback('📊 Статистика', 'menu_stats')]
    ]);
};

const getBackButton = () => {
    return Markup.inlineKeyboard([Markup.button.callback('🔙 Назад в меню', 'back_to_main')]);
};

const getCategoryKeyboard = () => {
    const buttons = CATEGORIES.map(cat => [Markup.button.callback(cat, `cat_${cat}`)]);
    buttons.push([Markup.button.callback('❌ Отмена', 'cancel')]);
    buttons.push([Markup.button.callback('🔙 Назад в меню', 'back_to_main')]);
    return Markup.inlineKeyboard(buttons);
};

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

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
        msg = await ctx.reply(text, { parse_mode: 'Markdown', ...inlineKeyboard });
    } else {
        msg = await ctx.reply(text, { parse_mode: 'Markdown' });
    }
    
    userLastMessages.set(userId, msg.message_id);
    return msg;
}

// ========== РАБОТА С ФАЙЛАМИ ==========
async function saveFile(ctx, fileId, originalName, customName, category, fileType, mimeType) {
    try {
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const extension = path.extname(originalName);
        const uniqueName = `${Date.now()}_${Math.random().toString(36).substring(7)}${extension}`;
        const tempPath = path.join(STORAGE_DIR, uniqueName);
        
        console.log(`📥 Скачиваю: ${originalName}`);
        const response = await fetch(fileLink.href);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(tempPath, buffer);
        
        const finalName = (customName && customName !== 'нет' && customName !== 'no') ? customName : originalName;
        
        return new Promise((resolve) => {
            db.run(
                `INSERT INTO files (original_name, custom_name, category, file_type, file_path, user_id, username)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [originalName, finalName, category, fileType, tempPath, ctx.from.id, ctx.from.username || ctx.from.first_name],
                function(err) {
                    if (err) {
                        console.error('❌ Ошибка БД:', err);
                        resolve({ success: false, error: err.message });
                    } else {
                        console.log(`✅ Файл сохранён, ID: ${this.lastID}`);
                        resolve({ success: true, name: finalName });
                    }
                }
            );
        });
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        return { success: false, error: error.message };
    }
}

// Сохранение ЛЮБОЙ ссылки (ИСПРАВЛЕНО)
async function saveLink(ctx, link, customName, category) {
    const finalName = customName || 'Ссылка';
    const originalName = finalName; // Важно: original_name не может быть NULL
    
    console.log(`🔗 Сохраняю ссылку: ${link.substring(0, 50)}...`);
    
    return new Promise((resolve) => {
        db.run(
            `INSERT INTO files (original_name, custom_name, category, file_type, drive_link, user_id, username)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [originalName, finalName, category, 'link', link, ctx.from.id, ctx.from.username || ctx.from.first_name],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка сохранения ссылки:', err);
                    resolve({ success: false, error: err.message });
                } else {
                    console.log(`✅ Ссылка сохранена, ID: ${this.lastID}`);
                    resolve({ success: true, name: finalName, link: link });
                }
            }
        );
    });
}

async function deleteFile(fileId, userId) {
    return new Promise((resolve) => {
        db.get('SELECT * FROM files WHERE id = ? AND user_id = ?', [fileId, userId], async (err, file) => {
            if (err || !file) {
                resolve({ success: false, error: 'Не найдено' });
                return;
            }
            
            if (file.file_path && fs.existsSync(file.file_path)) {
                fs.unlinkSync(file.file_path);
            }
            
            db.run('DELETE FROM files WHERE id = ? AND user_id = ?', [fileId, userId], (err) => {
                resolve({ success: !err, error: err?.message });
            });
        });
    });
}

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

async function deleteNote(noteId, userId) {
    return new Promise((resolve) => {
        db.run('DELETE FROM text_notes WHERE id = ? AND user_id = ?', [noteId, userId], (err) => {
            resolve({ success: !err, error: err?.message });
        });
    });
}

async function getNoteById(noteId) {
    return new Promise((resolve) => {
        db.get('SELECT * FROM text_notes WHERE id = ?', [noteId], (err, row) => {
            resolve(row);
        });
    });
}

// ========== ФУНКЦИИ ОТОБРАЖЕНИЯ ==========
async function showMainMenu(ctx) {
    const text = `👋 Привет, ${ctx.from.first_name}!

📚 *Общее хранилище файлов*

📤 Загружай файлы (до 50MB)
🔗 Добавляй любые ссылки
✏️ Создавай текстовые заметки
📥 Скачивай файлы
🗑️ Удаляй свои файлы

Выбери действие:`;
    await sendNewMessage(ctx, text, getMainMenuKeyboard());
}

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
        await sendNewMessage(ctx, '📭 У вас пока ничего нет.', getBackButton());
        return;
    }
    
    let text = '📂 *Ваши файлы и заметки*\n\n';
    const buttons = [];
    
    if (notes.length > 0) {
        text += '✏️ *Заметки:*\n\n';
        notes.forEach(note => {
            text += `📝 *${note.title}*\n📅 ${new Date(note.created_at).toLocaleDateString()}\n\n`;
            buttons.push([Markup.button.callback(`📖 "${note.title.substring(0, 20)}"`, `view_note_${note.id}`)]);
        });
        text += '\n';
    }
    
    if (files.length > 0) {
        text += '📎 *Файлы и ссылки:*\n\n';
        files.forEach(file => {
            const name = file.custom_name || file.original_name;
            const shortName = name.length > 25 ? name.substring(0, 25) + '...' : name;
            const typeIcon = file.file_type === 'link' ? '🔗' : '📄';
            text += `${typeIcon} ${name}\n📁 ${file.category}\n📅 ${new Date(file.created_at).toLocaleDateString()}\n\n`;
            buttons.push([
                Markup.button.callback(`🔗 ${shortName}`, `download_${file.id}`),
                Markup.button.callback(`🗑️ ${shortName}`, `delete_file_${file.id}`)
            ]);
        });
    }
    
    buttons.push([Markup.button.callback('🔙 Назад', 'back_to_main')]);
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

async function showAllFiles(ctx) {
    const files = await new Promise(resolve => {
        db.all('SELECT * FROM files ORDER BY created_at DESC LIMIT 30', [], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    if (files.length === 0) {
        await sendNewMessage(ctx, '📭 Нет файлов.', getBackButton());
        return;
    }
    
    let text = '📋 *Все файлы и ссылки:*\n\n';
    const buttons = [];
    
    files.forEach(file => {
        const name = file.custom_name || file.original_name;
        const shortName = name.length > 25 ? name.substring(0, 25) + '...' : name;
        const typeIcon = file.file_type === 'link' ? '🔗' : '📄';
        text += `${typeIcon} *${name}*\n📁 ${file.category}\n👤 ${file.username || `ID${file.user_id}`}\n📅 ${new Date(file.created_at).toLocaleString()}\n\n`;
        buttons.push([Markup.button.callback(`🔗 ${shortName}`, `download_${file.id}`)]);
    });
    
    buttons.push([Markup.button.callback('🔙 Назад', 'back_to_main')]);
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

async function showAllNotes(ctx) {
    const notes = await new Promise(resolve => {
        db.all('SELECT * FROM text_notes ORDER BY created_at DESC LIMIT 30', [], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    if (notes.length === 0) {
        await sendNewMessage(ctx, '📭 Нет заметок.', getBackButton());
        return;
    }
    
    let text = '📝 *Все заметки:*\n\n';
    const buttons = [];
    
    notes.forEach(note => {
        text += `📝 *${note.title}*\n👤 ${note.username || `ID${note.user_id}`}\n📅 ${new Date(note.created_at).toLocaleDateString()}\n\n`;
        buttons.push([Markup.button.callback(`📖 "${note.title.substring(0, 20)}"`, `view_note_${note.id}`)]);
    });
    
    buttons.push([Markup.button.callback('🔙 Назад', 'back_to_main')]);
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

async function showStats(ctx) {
    const stats = await new Promise(resolve => {
        db.get(`SELECT 
            (SELECT COUNT(*) FROM files) as files,
            (SELECT COUNT(*) FROM text_notes) as notes,
            (SELECT COUNT(DISTINCT user_id) FROM (SELECT user_id FROM files UNION SELECT user_id FROM text_notes)) as users`,
            [], (err, row) => resolve(row || { files: 0, notes: 0, users: 0 })
        );
    });
    
    const catStats = await new Promise(resolve => {
        db.all('SELECT category, COUNT(*) as count FROM files GROUP BY category', [], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    let catMsg = '';
    catStats.forEach(s => catMsg += `${s.category}: ${s.count}\n`);
    
    const text = `📊 *Статистика*\n\n` +
        `📄 Файлов/ссылок: ${stats.files}\n✏️ Заметок: ${stats.notes}\n👥 Пользователей: ${stats.users}\n\n` +
        `*По категориям:*\n${catMsg || 'Нет'}`;
    
    await sendNewMessage(ctx, text, getBackButton());
}

async function showFullNote(ctx, noteId) {
    const note = await getNoteById(noteId);
    if (!note) {
        await sendNewMessage(ctx, '❌ Заметка не найдена', getBackButton());
        return;
    }
    
    const text = `📝 *${note.title}*\n\n📁 ${note.category}\n👤 ${note.username || `ID${note.user_id}`}\n📅 ${new Date(note.created_at).toLocaleString()}\n\n📄 *Текст:*\n${note.content}`;
    
    const buttons = [
        [Markup.button.callback('🗑️ Удалить', `delete_note_${note.id}`)],
        [Markup.button.callback('🔙 Назад', 'back_to_main')]
    ];
    
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

async function showSearchPrompt(ctx) {
    userStates.set(ctx.from.id, { action: 'search' });
    await sendNewMessage(ctx, '🔎 Введите текст для поиска (или "отмена"):', getBackButton());
}

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
        await sendNewMessage(ctx, '❌ Ничего не найдено', getBackButton());
        return;
    }
    
    let text = `🔍 *Результаты:* "${query}"\n\n`;
    const buttons = [];
    
    if (notes.length > 0) {
        text += '✏️ *Заметки:*\n';
        notes.forEach(n => {
            text += `📝 ${n.title}\n`;
            buttons.push([Markup.button.callback(`📖 "${n.title.substring(0, 20)}"`, `view_note_${n.id}`)]);
        });
        text += '\n';
    }
    
    if (files.length > 0) {
        text += '📎 *Файлы и ссылки:*\n';
        files.forEach(f => {
            const name = f.custom_name || f.original_name;
            text += `${f.file_type === 'link' ? '🔗' : '📄'} ${name}\n`;
            buttons.push([Markup.button.callback(`🔗 ${name.substring(0, 20)}`, `download_${f.id}`)]);
        });
    }
    
    buttons.push([Markup.button.callback('🔙 Назад', 'back_to_main')]);
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// ========== ОБРАБОТЧИКИ КНОПОК ==========
bot.start(async (ctx) => {
    console.log(`🚀 /start от ${ctx.from.id}`);
    userStates.clear();
    userLastMessages.delete(ctx.from.id);
    await showMainMenu(ctx);
});

bot.action('menu_upload', async (ctx) => {
    await ctx.answerCbQuery();
    userStates.set(ctx.from.id, { action: 'waiting_for_file' });
    await sendNewMessage(ctx, `📎 Отправьте файл (до 50MB)\n\nПоддерживаются: ${ALLOWED_EXTENSIONS.join(', ')}`, getBackButton());
});

bot.action('menu_add_link', async (ctx) => {
    await ctx.answerCbQuery();
    userStates.set(ctx.from.id, { action: 'waiting_for_link' });
    await sendNewMessage(ctx, 
        `🔗 *Добавление ссылки*\n\n` +
        `Отправьте ЛЮБУЮ ссылку:\n` +
        `• YouTube: https://youtu.be/...\n` +
        `• Google Drive: https://drive.google.com/...\n` +
        `• Любой файл: https://example.com/file.pdf\n` +
        `• Любой сайт: https://example.com\n\n` +
        `Ссылка будет сохранена в хранилище.`,
        getBackButton()
    );
});

bot.action('menu_create_note', async (ctx) => {
    await ctx.answerCbQuery();
    userStates.set(ctx.from.id, { action: 'waiting_for_note' });
    await sendNewMessage(ctx, '📝 Отправьте:\n\n`Название\nТекст заметки`', getBackButton());
});

bot.action('menu_my_files', async (ctx) => {
    await ctx.answerCbQuery();
    await showMyFiles(ctx);
});

bot.action('menu_all_files', async (ctx) => {
    await ctx.answerCbQuery();
    await showAllFiles(ctx);
});

bot.action('menu_all_notes', async (ctx) => {
    await ctx.answerCbQuery();
    await showAllNotes(ctx);
});

bot.action('menu_search', async (ctx) => {
    await ctx.answerCbQuery();
    await showSearchPrompt(ctx);
});

bot.action('menu_stats', async (ctx) => {
    await ctx.answerCbQuery();
    await showStats(ctx);
});

bot.action('back_to_main', async (ctx) => {
    await ctx.answerCbQuery();
    await showMainMenu(ctx);
});

bot.action(/view_note_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    await showFullNote(ctx, parseInt(ctx.match[1]));
});

bot.action(/cat_(.+)/, async (ctx) => {
    const category = ctx.match[1];
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    
    await ctx.answerCbQuery();
    
    if (state?.pendingFile) {
        const result = await saveFile(ctx, state.fileId, state.fileName, state.customName, category, state.fileType, state.mimeType);
        const msg = result.success ? `✅ Файл "${result.name}" сохранён в ${category}` : `❌ ${result.error}`;
        await sendNewMessage(ctx, msg, getBackButton());
        userStates.delete(userId);
    } else if (state?.pendingLink) {
        const result = await saveLink(ctx, state.link, state.customName, category);
        const msg = result.success ? `✅ Ссылка сохранена в ${category}!\n\n🔗 ${result.link}` : `❌ ${result.error}`;
        await sendNewMessage(ctx, msg, getBackButton());
        userStates.delete(userId);
    } else {
        await sendNewMessage(ctx, '❌ Действие отменено', getBackButton());
        userStates.delete(userId);
    }
});

bot.action('cancel', async (ctx) => {
    await ctx.answerCbQuery();
    userStates.delete(ctx.from.id);
    await showMainMenu(ctx);
});

bot.action(/download_(\d+)/, async (ctx) => {
    const fileId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    
    const file = await new Promise(resolve => {
        db.get('SELECT * FROM files WHERE id = ?', [fileId], (err, row) => resolve(row));
    });
    
    if (!file) return ctx.reply('❌ Не найдено');
    
    const name = file.custom_name || file.original_name;
    
    if (file.drive_link) {
        await ctx.reply(`🔗 *${name}*\n\n${file.drive_link}\n\n📁 ${file.category}\n👤 ${file.username}\n📅 ${new Date(file.created_at).toLocaleString()}`, { parse_mode: 'Markdown' });
    } else if (file.file_path && fs.existsSync(file.file_path)) {
        await ctx.replyWithDocument({ source: file.file_path }, { caption: `📄 ${name}\n📁 ${file.category}\n👤 ${file.username}\n📅 ${new Date(file.created_at).toLocaleString()}` });
    } else {
        await ctx.reply('❌ Не найдено');
    }
});

bot.action(/delete_file_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const result = await deleteFile(parseInt(ctx.match[1]), ctx.from.id);
    if (result.success) await showMyFiles(ctx);
    else await sendNewMessage(ctx, `❌ ${result.error}`, getBackButton());
});

bot.action(/delete_note_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const result = await deleteNote(parseInt(ctx.match[1]), ctx.from.id);
    if (result.success) await showMyFiles(ctx);
    else await sendNewMessage(ctx, `❌ ${result.error}`, getBackButton());
});

// ========== ОБРАБОТКА ВХОДЯЩИХ ДАННЫХ ==========
bot.on('document', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    
    if (!state || state.action !== 'waiting_for_file') {
        await sendNewMessage(ctx, '⚠️ Сначала выберите "📤 Загрузить файл"', getBackButton());
        return;
    }
    
    const doc = ctx.message.document;
    const ext = path.extname(doc.file_name).toLowerCase();
    
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        await sendNewMessage(ctx, `❌ Разрешены: ${ALLOWED_EXTENSIONS.join(', ')}`, getBackButton());
        return;
    }
    
    userStates.set(userId, {
        action: 'waiting_name',
        fileId: doc.file_id,
        fileName: doc.file_name,
        fileType: ext.substring(1),
        mimeType: doc.mime_type,
        pendingFile: true
    });
    
    await sendNewMessage(ctx, `📁 "${doc.file_name}"\n📊 ${formatFileSize(doc.file_size)}\n\nВведите название (или "нет"):`, getBackButton());
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    const text = ctx.message.text;
    
    // Обработка названия для файла
    if (state?.action === 'waiting_name') {
        const customName = (text !== 'нет' && text !== 'no') ? text : null;
        userStates.set(userId, { ...state, action: 'select_category', customName: customName });
        await sendNewMessage(ctx, `📁 Название: ${customName || state.fileName}\n\nВыберите категорию:`, getCategoryKeyboard());
        return;
    }
    
    // Обработка ссылки (ПРИНИМАЕМ ЛЮБУЮ ССЫЛКУ)
    if (state?.action === 'waiting_for_link') {
        let link = text.trim();
        
        if (!link.startsWith('http://') && !link.startsWith('https://')) {
            link = 'https://' + link;
        }
        
        userStates.set(userId, {
            action: 'waiting_link_name',
            link: link,
            pendingLink: true
        });
        
        await sendNewMessage(ctx, `🔗 Ссылка принята!\n\nВведите название (или "нет"):`, getBackButton());
        return;
    }
    
    // Обработка названия для ссылки
    if (state?.action === 'waiting_link_name') {
        const customName = (text !== 'нет' && text !== 'no') ? text : null;
        userStates.set(userId, { ...state, action: 'select_category_for_link', customName: customName });
        await sendNewMessage(ctx, `📁 Название: ${customName || 'Ссылка'}\n\nВыберите категорию:`, getCategoryKeyboard());
        return;
    }
    
    // Создание заметки
    if (state?.action === 'waiting_for_note') {
        const lines = text.trim().split('\n');
        if (lines.length < 2) {
            await sendNewMessage(ctx, '❌ Неверный формат. Нужно:\n\n`Название\nТекст заметки`', getBackButton());
            return;
        }
        
        const title = lines[0].trim();
        const content = lines.slice(1).join('\n').trim();
        
        if (!title) {
            await sendNewMessage(ctx, '❌ Название не может быть пустым', getBackButton());
            return;
        }
        
        await saveNote(ctx, title, content);
        await sendNewMessage(ctx, `✅ Заметка "${title}" сохранена!`, getBackButton());
        userStates.delete(userId);
        return;
    }
    
    // Поиск
    if (state?.action === 'search') {
        if (text.toLowerCase() === 'отмена') {
            userStates.delete(userId);
            await showMainMenu(ctx);
        } else {
            await handleSearch(ctx, text);
            userStates.delete(userId);
        }
        return;
    }
});

// ========== ЗАПУСК В РЕЖИМЕ WEBHOOK (ДЛЯ RENDER) ==========
const express = require('express');
const app = express();
app.use(express.json());

// Эндпоинт для вебхука Telegram
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
});

// Запуск сервера на порту, который задаёт Render
const port = process.env.PORT || 10000;
app.listen(port, async () => {
    console.log(`✅ Сервер запущен на порту ${port}`);
    
    // Устанавливаем вебхук (замените URL на ваш реальный)
    const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/webhook/${BOT_TOKEN}`;
    try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`✅ Вебхук установлен: ${webhookUrl}`);
    } catch (error) {
        console.error('❌ Ошибка установки вебхука:', error.message);
    }
});

// Graceful stop
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    process.exit(0);
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    process.exit(0);
});