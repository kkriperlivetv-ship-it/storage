require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

console.log('🚀 НАЧАЛО ЗАГРУЗКИ БОТА');
console.log('📁 Текущая директория:', __dirname);

if (!process.env.BOT_TOKEN) {
    console.error('❌ Ошибка: BOT_TOKEN не найден в файле .env');
    process.exit(1);
}

console.log('✅ Токен загружен');

const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_DIR = './storage';

if (!fs.existsSync(STORAGE_DIR)) {
    console.log('📁 Создаю папку storage');
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

console.log('🗄️ Подключение к базе данных...');
const db = new sqlite3.Database('storage.db');

db.serialize(() => {
    console.log('📋 Создание таблиц...');
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
            console.log('⚠️ Колонка custom_name не добавлена:', err.message);
        } else {
            console.log('✅ Колонка custom_name готова');
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
            console.error('❌ Ошибка создания таблицы:', err);
        } else {
            console.log('✅ Таблицы созданы');
        }
    });
});

console.log('🤖 Создание экземпляра бота...');
const bot = new Telegraf(BOT_TOKEN);

// Хранилища
const userStates = new Map();
const userLastMessages = new Map();

const CATEGORIES = ['📁 Документы', '📁 Прочее', '🎵 Медиа', '💻 Архивы', '📝 Заметки'];

// Разрешённые форматы файлов
const ALLOWED_EXTENSIONS = ['.txt', '.zip', '.rar', '.pdf', '.docx', '.jpg', '.jpeg', '.png'];

console.log('📋 Категории:', CATEGORIES);
console.log('📎 Разрешённые форматы:', ALLOWED_EXTENSIONS);

// ========== INLINE-КЛАВИАТУРЫ ==========

const getMainMenuKeyboard = () => {
    console.log('🔘 Создана клавиатура главного меню');
    return Markup.inlineKeyboard([
        [Markup.button.callback('📤 Загрузить файл', 'menu_upload')],
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

// Функция для отправки нового сообщения
async function sendNewMessage(ctx, text, inlineKeyboard = null) {
    const userId = ctx.from.id;
    const lastMessageId = userLastMessages.get(userId);
    
    console.log(`📝 sendNewMessage для ${userId}`);
    console.log(`   Текст: ${text.substring(0, 100)}...`);
    console.log(`   Старый ID сообщения: ${lastMessageId || 'нет'}`);
    
    if (lastMessageId) {
        try {
            await ctx.telegram.deleteMessage(ctx.chat.id, lastMessageId);
            console.log(`   ✅ Удалено сообщение ${lastMessageId}`);
        } catch (error) {
            console.log(`   ❌ Не удалось удалить: ${error.message}`);
        }
    }
    
    let msg;
    try {
        if (inlineKeyboard) {
            console.log(`   Отправка с клавиатурой`);
            msg = await ctx.reply(text, {
                parse_mode: 'Markdown',
                ...inlineKeyboard
            });
        } else {
            console.log(`   Отправка без клавиатуры`);
            msg = await ctx.reply(text, { parse_mode: 'Markdown' });
        }
        console.log(`   ✅ Отправлено новое сообщение ID: ${msg.message_id}`);
        userLastMessages.set(userId, msg.message_id);
        return msg;
    } catch (error) {
        console.error(`   ❌ ОШИБКА отправки:`, error.message);
        throw error;
    }
}

// Показать главное меню
async function showMainMenu(ctx) {
    console.log(`\n========== showMainMenu ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id} (${ctx.from.first_name})`);
    console.log(`💬 Чат ID: ${ctx.chat.id}`);
    
    const text = `👋 Привет, ${ctx.from.first_name}!

📚 *Общее хранилище файлов*

📎 Загружай файлы (${ALLOWED_EXTENSIONS.join(', ')})
✏️ Создавай текстовые заметки
📥 Скачивай файлы других пользователей
🗑️ Удаляй свои файлы и заметки

Выбери действие:`;
    
    console.log(`📤 Отправка главного меню...`);
    await sendNewMessage(ctx, text, getMainMenuKeyboard());
    console.log(`✅ Главное меню отправлено`);
}

// Сохранение файла
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

// Показать мои файлы
async function showMyFiles(ctx) {
    console.log(`📂 showMyFiles для ${ctx.from.id}`);
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
        await sendNewMessage(ctx, '📭 У вас пока нет сохранённых файлов или заметок.', getBackButton());
        return;
    }
    
    let text = '📂 *Ваши файлы и заметки*\n\n';
    const buttons = [];
    
    if (notes.length > 0) {
        text += '✏️ *Заметки:*\n\n';
        notes.forEach(note => {
            const shortTitle = note.title.length > 30 ? note.title.substring(0, 30) + '...' : note.title;
            text += `📝 *${note.title}*\n📅 ${new Date(note.created_at).toLocaleDateString()}\n\n`;
            buttons.push([Markup.button.callback(`📖 Просмотреть "${shortTitle}"`, `view_note_${note.id}`)]);
        });
        text += '\n';
    }
    
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
    
    buttons.push([Markup.button.callback('🔙 Назад в меню', 'back_to_main')]);
    
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// Показать все файлы
async function showAllFiles(ctx) {
    console.log(`📋 showAllFiles для ${ctx.from.id}`);
    
    const files = await new Promise(resolve => {
        db.all('SELECT * FROM files ORDER BY created_at DESC LIMIT 30', [], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    if (files.length === 0) {
        await sendNewMessage(ctx, '📭 Пока нет ни одного файла в хранилище.', getBackButton());
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
    
    buttons.push([Markup.button.callback('🔙 Назад в меню', 'back_to_main')]);
    
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// Показать все заметки
async function showAllNotes(ctx) {
    console.log(`📝 showAllNotes для ${ctx.from.id}`);
    
    const notes = await new Promise(resolve => {
        db.all('SELECT * FROM text_notes ORDER BY created_at DESC LIMIT 30', [], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    if (notes.length === 0) {
        await sendNewMessage(ctx, '📭 Пока нет ни одной заметки.', getBackButton());
        return;
    }
    
    let text = '📝 *Все заметки пользователей:*\n\n';
    const buttons = [];
    
    notes.forEach(note => {
        const shortTitle = note.title.length > 30 ? note.title.substring(0, 30) + '...' : note.title;
        text += `📝 *${note.title}*\n👤 ${note.username || `ID${note.user_id}`}\n📅 ${new Date(note.created_at).toLocaleDateString()}\n\n`;
        buttons.push([Markup.button.callback(`📖 Читать "${shortTitle}"`, `view_note_${note.id}`)]);
    });
    
    buttons.push([Markup.button.callback('🔙 Назад в меню', 'back_to_main')]);
    
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// Показать статистику
async function showStats(ctx) {
    console.log(`📊 showStats для ${ctx.from.id}`);
    
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
    
    await sendNewMessage(ctx, text, getBackButton());
}

// Поиск
async function showSearchPrompt(ctx) {
    console.log(`🔍 showSearchPrompt для ${ctx.from.id}`);
    userStates.set(ctx.from.id, { action: 'search' });
    await sendNewMessage(ctx, '🔎 Введите текст для поиска (или отправьте "отмена"):', getBackButton());
}

async function handleSearch(ctx, query) {
    console.log(`🔎 handleSearch для ${ctx.from.id}: "${query}"`);
    
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
    
    buttons.push([Markup.button.callback('🔙 Назад в меню', 'back_to_main')]);
    
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// Показать заметку полностью
async function showFullNote(ctx, noteId) {
    console.log(`📖 showFullNote для ${ctx.from.id}, заметка ${noteId}`);
    
    const note = await getNoteById(noteId);
    if (!note) {
        await sendNewMessage(ctx, '❌ Заметка не найдена', getBackButton());
        return;
    }
    
    const text = `📝 *${note.title}*\n\n📁 ${note.category}\n👤 ${note.username || `ID${note.user_id}`}\n📅 ${new Date(note.created_at).toLocaleString()}\n\n📄 *Текст заметки:*\n${note.content}`;
    
    const buttons = [
        [Markup.button.callback('🗑️ Удалить заметку', `delete_note_${note.id}`)],
        [Markup.button.callback('🔙 Назад к моим файлам', 'back_to_my_files')]
    ];
    
    await sendNewMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

// ========== ОБРАБОТЧИКИ ==========

console.log('🔄 Регистрация обработчиков...');

bot.start(async (ctx) => {
    console.log(`\n🚀 ========== /start ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id} (${ctx.from.first_name})`);
    console.log(`💬 Чат ID: ${ctx.chat.id}`);
    console.log(`📝 Текст: ${ctx.message.text}`);
    
    userStates.delete(ctx.from.id);
    userLastMessages.delete(ctx.from.id);
    
    console.log(`📤 Вызов showMainMenu...`);
    await showMainMenu(ctx);
    console.log(`✅ /start обработан`);
});

bot.action('menu_upload', async (ctx) => {
    console.log(`\n📤 ========== menu_upload ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
    await ctx.answerCbQuery();
    userStates.set(ctx.from.id, { action: 'waiting_for_file_name' });
    await sendNewMessage(ctx, `📎 Отправьте файл (${ALLOWED_EXTENSIONS.join(', ')}):\n\nСначала отправьте файл, потом я спрошу название.`, getBackButton());
});

bot.action('menu_create_note', async (ctx) => {
    console.log(`\n✏️ ========== menu_create_note ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
    await ctx.answerCbQuery();
    userStates.set(ctx.from.id, { action: 'waiting_for_note' });
    await sendNewMessage(ctx, '📝 Отправьте текст в формате:\n\n`Название\nТекст заметки`\n\nЗаметка сохранится в категорию "📝 Заметки"', getBackButton());
});

bot.action('menu_my_files', async (ctx) => {
    console.log(`\n📂 ========== menu_my_files ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
    await ctx.answerCbQuery();
    await showMyFiles(ctx);
});

bot.action('menu_all_files', async (ctx) => {
    console.log(`\n📋 ========== menu_all_files ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
    await ctx.answerCbQuery();
    await showAllFiles(ctx);
});

bot.action('menu_all_notes', async (ctx) => {
    console.log(`\n📝 ========== menu_all_notes ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
    await ctx.answerCbQuery();
    await showAllNotes(ctx);
});

bot.action('menu_search', async (ctx) => {
    console.log(`\n🔍 ========== menu_search ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
    await ctx.answerCbQuery();
    await showSearchPrompt(ctx);
});

bot.action('menu_stats', async (ctx) => {
    console.log(`\n📊 ========== menu_stats ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
    await ctx.answerCbQuery();
    await showStats(ctx);
});

bot.action('back_to_main', async (ctx) => {
    console.log(`\n🔙 ========== back_to_main ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
    await ctx.answerCbQuery();
    await showMainMenu(ctx);
});

bot.action('back_to_my_files', async (ctx) => {
    console.log(`\n🔙 ========== back_to_my_files ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
    await ctx.answerCbQuery();
    await showMyFiles(ctx);
});

bot.action(/view_note_(\d+)/, async (ctx) => {
    const noteId = parseInt(ctx.match[1]);
    console.log(`\n📖 ========== view_note_${noteId} ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
    await ctx.answerCbQuery();
    await showFullNote(ctx, noteId);
});

bot.action(/cat_(.+)/, async (ctx) => {
    const category = ctx.match[1];
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    
    console.log(`\n🏷️ ========== cat_${category} ==========`);
    console.log(`👤 Пользователь: ${userId}`);
    console.log(`📦 Состояние:`, state);
    
    await ctx.answerCbQuery();
    
    if (state && state.pendingFile) {
        const customName = state.customName;
        const result = await saveFile(ctx, state.fileId, state.fileName, customName, category, state.fileType);
        
        if (result.success) {
            await sendNewMessage(ctx, `✅ Файл "${result.name}" сохранён в категорию ${category}!`, getBackButton());
        } else {
            await sendNewMessage(ctx, `❌ Ошибка: ${result.error}`, getBackButton());
        }
        
        userStates.delete(userId);
    } else {
        await sendNewMessage(ctx, '❌ Действие отменено', getBackButton());
        userStates.delete(userId);
    }
});

bot.action('cancel', async (ctx) => {
    console.log(`\n❌ ========== cancel ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
    await ctx.answerCbQuery('Отменено');
    userStates.delete(ctx.from.id);
    await showMainMenu(ctx);
});

bot.action(/download_(\d+)/, async (ctx) => {
    const fileId = parseInt(ctx.match[1]);
    console.log(`\n📥 ========== download_${fileId} ==========`);
    console.log(`👤 Пользователь: ${ctx.from.id}`);
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

bot.action(/delete_file_(\d+)/, async (ctx) => {
    const fileId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;
    
    console.log(`\n🗑️ ========== delete_file_${fileId} ==========`);
    console.log(`👤 Пользователь: ${userId}`);
    await ctx.answerCbQuery('⏳ Удаляю...');
    
    const result = await deleteFile(fileId, userId);
    
    if (result.success) {
        await showMyFiles(ctx);
    } else {
        await sendNewMessage(ctx, `❌ Ошибка: ${result.error}`, getBackButton());
    }
});

bot.action(/delete_note_(\d+)/, async (ctx) => {
    const noteId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;
    
    console.log(`\n🗑️ ========== delete_note_${noteId} ==========`);
    console.log(`👤 Пользователь: ${userId}`);
    await ctx.answerCbQuery('⏳ Удаляю...');
    
    const result = await deleteNote(noteId, userId);
    
    if (result.success) {
        await showMyFiles(ctx);
    } else {
        await sendNewMessage(ctx, `❌ Ошибка: ${result.error}`, getBackButton());
    }
});

// Обработка файлов
bot.on('document', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    
    console.log(`\n📎 ========== ПОЛУЧЕН ФАЙЛ ==========`);
    console.log(`👤 Пользователь: ${userId}`);
    console.log(`📦 Состояние: ${state?.action || 'нет'}`);
    
    if (!state || state.action !== 'waiting_for_file_name') {
        console.log(`⚠️ Неправильное состояние, ожидается waiting_for_file_name`);
        await sendNewMessage(ctx, '⚠️ Сначала выберите "📤 Загрузить файл" в меню', getBackButton());
        return;
    }
    
    const doc = ctx.message.document;
    const fileName = doc.file_name;
    const ext = path.extname(fileName).toLowerCase();
    
    console.log(`📄 Имя файла: ${fileName}`);
    console.log(`🔧 Расширение: ${ext}`);
    
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        console.log(`❌ Расширение ${ext} не разрешено`);
        await sendNewMessage(ctx, `❌ Разрешены только: ${ALLOWED_EXTENSIONS.join(', ')}`, getBackButton());
        return;
    }
    
    userStates.set(userId, {
        action: 'waiting_for_custom_name',
        fileId: doc.file_id,
        fileName: fileName,
        fileType: ext.substring(1),
        originalName: fileName
    });
    
    console.log(`✅ Файл принят, состояние изменено на waiting_for_custom_name`);
    await sendNewMessage(ctx, `📁 Файл "${fileName}" получен!\n\nВведите название для файла (или отправьте "нет" для использования оригинального названия):`, getBackButton());
});

// Обработка текста
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    const text = ctx.message.text;
    
    console.log(`\n💬 ========== ПОЛУЧЕН ТЕКСТ ==========`);
    console.log(`👤 Пользователь: ${userId}`);
    console.log(`📝 Текст: ${text}`);
    console.log(`📦 Состояние: ${state?.action || 'нет'}`);
    
    // Обработка названия для файла
    if (state && state.action === 'waiting_for_custom_name') {
        console.log(`📝 Обработка названия файла`);
        
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
        
        console.log(`✅ Название: ${customName || state.fileName}`);
        await sendNewMessage(ctx, `📁 Название: ${customName || state.fileName}\n\nТеперь выберите категорию:`, getCategoryKeyboard());
        return;
    }
    
    // Создание заметки
    if (state && state.action === 'waiting_for_note') {
        console.log(`📝 Обработка создания заметки`);
        
        const lines = text.trim().split('\n');
        
        if (lines.length < 2) {
            console.log(`❌ Неверный формат: нужно минимум 2 строки`);
            await sendNewMessage(ctx, '❌ Неверный формат. Нужно:\n\n`Название\nТекст`', getBackButton());
            return;
        }
        
        const title = lines[0].trim();
        const content = lines.slice(1).join('\n').trim();
        
        if (!title) {
            console.log(`❌ Пустое название`);
            await sendNewMessage(ctx, '❌ Название не может быть пустым', getBackButton());
            return;
        }
        
        console.log(`✅ Сохранение заметки "${title}"`);
        await saveNote(ctx, title, content);
        await sendNewMessage(ctx, `✅ Заметка "${title}" сохранена!`, getBackButton());
        userStates.delete(userId);
        return;
    }
    
    // Поиск
    if (state && state.action === 'search') {
        console.log(`🔍 Обработка поискового запроса`);
        
        if (text.toLowerCase() === 'отмена') {
            console.log(`❌ Поиск отменён`);
            userStates.delete(userId);
            await showMainMenu(ctx);
            return;
        }
        
        await handleSearch(ctx, text);
        userStates.delete(userId);
        return;
    }
    
    console.log(`⚠️ Текст не был обработан (нет соответствующего состояния)`);
});

// ========== ЗАПУСК ==========
console.log('\n🚀 ЗАПУСК БОТА...\n');

// Для локального тестирования используем polling
bot.launch().then(() => {
    console.log('✅ Бот успешно запущен!');
    console.log('💡 Бот готов к работе!');
    console.log('📱 Откройте Telegram и отправьте /start\n');
}).catch((err) => {
    console.error('❌ Ошибка запуска бота:', err);
});

// Graceful stop
process.once('SIGINT', () => {
    console.log('\n🛑 Остановка бота...');
    bot.stop('SIGINT');
    process.exit(0);
});
process.once('SIGTERM', () => {
    console.log('\n🛑 Остановка бота...');
    bot.stop('SIGTERM');
    process.exit(0);
});