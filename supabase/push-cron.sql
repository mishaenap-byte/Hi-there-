-- Hi There: вечернее напоминание о повторении слов каждый день в 16:00 по UTC
-- (19:00 в Кишинёве и Москве летом). Перед запуском замените ВАШ_CRON_KEY на тот же текст,
-- что вы записали в Secrets → CRON_KEY.
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.schedule('hithere-push-daily', '0 16 * * *', $$
  select net.http_post(
    url     := 'https://jdpreowtaahhqaalzhgi.supabase.co/functions/v1/push-send',
    headers := '{"Content-Type": "application/json", "x-cron-key": "ВАШ_CRON_KEY"}'::jsonb,
    body    := '{"mode": "daily"}'::jsonb
  );
$$);
-- Поменять время: select cron.unschedule('hithere-push-daily'); и запустить этот файл снова с другим временем.
